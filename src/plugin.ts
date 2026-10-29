import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { authorFeedUrl, type FeedItem, ownPosts, REQUIRED_FIELDS } from "./bluesky";

const DEFAULT_COLLECTION = "bluesky";
const CRON_TASK = "sync";
const CRON_SCHEDULE = "*/5 * * * *";
/** How many recent posts to look at on each run. */
const FETCH_LIMIT = 30;
/** How many existing entries to check against, newest first. */
const EXISTING_LIMIT = 100;
/**
 * How many posts to save, publish or clean up on each run. On a deployed
 * site one save and publish can take several seconds, and the Cloudflare
 * sandbox allows 10 subrequests per invocation, where every `ctx` call
 * counts as one. A run that saves a post makes 9: settings, schema, feed,
 * entries, storage, create, remember, revision, publish. The rest wait for
 * the next run.
 */
const MAX_PER_RUN = 1;
/**
 * Time limit for one scheduled run. The host's default is 5 seconds, which
 * a deployed run can exceed when the database is far away.
 */
const CRON_TIMEOUT_MS = 120_000;

/**
 * What the plugin remembers about a post it has saved, keyed by record
 * key. It is what stops a post deleted in the admin from coming back.
 */
interface SyncedPost {
	contentId: string;
	postedAt: string;
}

type SyncResult =
	| {
			status: "ok";
			created: number;
			published: number;
			duplicatesRemoved: number;
			remaining: number;
	  }
	| { status: "not_configured" }
	| { status: "collection_invalid"; collection: string; problems: string[] }
	| { status: "fetch_failed"; httpStatus: number };

interface Existing {
	id: string;
	status: string;
	createdAt: string;
}

async function scheduleSync(ctx: PluginContext) {
	await ctx.cron?.schedule(CRON_TASK, { schedule: CRON_SCHEDULE });
}

/** All settings in one call, to save subrequests. */
async function readSettings(ctx: PluginContext) {
	const values = new Map((await ctx.settings.list()).map(({ key, value }) => [key, value]));
	const collection = values.get("collection");
	return {
		actor: normalizeActor(values.get("handle")),
		collection: (typeof collection === "string" && collection.trim()) || DEFAULT_COLLECTION,
	};
}

/** Accepts "name.bsky.social", "@name.bsky.social", or a DID. */
function normalizeActor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const actor = value.trim().replace(/^@/, "");
	return actor || null;
}

/** Problems that would stop the plugin writing to the collection, if any. */
async function collectionProblems(ctx: PluginContext, slug: string): Promise<string[]> {
	const collection = await ctx.schema?.getCollection(slug);
	if (!collection) return [`collection "${slug}" does not exist`];
	const types = new Map(collection.fields.map((field) => [field.slug, field.type]));
	return Object.entries(REQUIRED_FIELDS).flatMap(([slug, type]) => {
		const actual = types.get(slug);
		if (!actual) return [`missing field "${slug}" (${type})`];
		return actual === type ? [] : [`field "${slug}" is ${actual}, expected ${type}`];
	});
}

/**
 * Entries already in the collection, grouped by the post they hold. A run
 * can be cut off between saving an entry and remembering it, so this, not
 * plugin storage, is what decides whether a post is already saved.
 */
async function existingByUri(ctx: PluginContext, collection: string) {
	const { items } = await ctx.content!.list(collection, { limit: EXISTING_LIMIT });
	const byUri = new Map<string, Existing[]>();
	for (const item of items) {
		const uri = item.data.post_uri;
		if (typeof uri !== "string") continue;
		const list = byUri.get(uri) ?? [];
		list.push({ id: item.id, status: item.status, createdAt: item.createdAt });
		byUri.set(uri, list);
	}
	return byUri;
}

/** The entry to keep among copies of one post: a published one, else the oldest. */
function keeperOf(copies: Existing[]): Existing {
	const sorted = [...copies].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return sorted.find((copy) => copy.status === "published") ?? sorted[0]!;
}

async function publish(ctx: PluginContext, collection: string, id: string): Promise<boolean> {
	try {
		const versioned = await ctx.content!.getVersioned!(collection, id);
		if (!versioned) return false;
		if (versioned.item.status !== "published") {
			await ctx.content!.publish!(collection, id, { _rev: versioned._rev });
		}
		return true;
	} catch (error) {
		ctx.log.error("Saved a Bluesky post but could not publish it", {
			contentId: id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

async function sync(ctx: PluginContext): Promise<SyncResult> {
	const { actor, collection } = await readSettings(ctx);
	if (!actor) return { status: "not_configured" };

	const problems = await collectionProblems(ctx, collection);
	if (problems.length > 0) {
		ctx.log.warn("Bluesky Feed cannot write to the collection", { collection, problems });
		return { status: "collection_invalid", collection, problems };
	}

	const response = await ctx.http!.fetch(authorFeedUrl(actor, FETCH_LIMIT), {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		ctx.log.warn("Bluesky feed request failed", { status: response.status });
		return { status: "fetch_failed", httpStatus: response.status };
	}
	const body = (await response.json()) as { feed?: FeedItem[] };
	const posts = ownPosts(Array.isArray(body.feed) ? body.feed : []);

	const synced = ctx.storage.posts!;
	const [existing, remembered] = await Promise.all([
		existingByUri(ctx, collection),
		synced.getMany(posts.map((post) => post.rkey)),
	]);

	let budget = MAX_PER_RUN;
	let published = 0;

	// Copies left by runs that were cut off: keep one, move the rest to the trash.
	let duplicatesRemoved = 0;
	for (const copies of existing.values()) {
		if (copies.length < 2) continue;
		const keep = keeperOf(copies);
		for (const copy of copies) {
			if (copy === keep || budget === 0) continue;
			budget--;
			if (await ctx.content!.delete!(collection, copy.id)) duplicatesRemoved++;
		}
		copies.splice(0, copies.length, keep);
	}

	// Saved earlier but never published.
	for (const post of posts) {
		if (budget === 0) break;
		const entry = existing.get(post.fields.post_uri)?.[0];
		if (!entry || entry.status === "published") continue;
		budget--;
		if (await publish(ctx, collection, entry.id)) published++;
		if (!remembered.has(post.rkey)) {
			await synced.put(post.rkey, { contentId: entry.id, postedAt: post.fields.posted_at });
		}
	}

	// Not saved yet, and not deleted in the admin after an earlier save.
	const pending = posts.filter(
		(post) => !existing.has(post.fields.post_uri) && !remembered.has(post.rkey),
	);
	let created = 0;
	for (const post of pending.slice(0, budget)) {
		const item = await ctx.content!.create!(collection, { ...post.fields });
		await synced.put(post.rkey, { contentId: item.id, postedAt: post.fields.posted_at } satisfies SyncedPost);
		created++;
		if (await publish(ctx, collection, item.id)) published++;
	}

	return {
		status: "ok",
		created,
		published,
		duplicatesRemoved,
		remaining: pending.length - created,
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => scheduleSync(ctx),
		"plugin:activate": async (_event, ctx) => scheduleSync(ctx),
		cron: {
			timeout: CRON_TIMEOUT_MS,
			handler: async (event, ctx) => {
				// No log on success: a log line is a subrequest too.
				if (event.name === CRON_TASK) await sync(ctx);
			},
		},
	},
	routes: {
		// Admin-only (the default `plugins:manage` permission): run a sync now.
		sync: {
			methods: ["POST"],
			handler: async (_routeCtx, ctx) => sync(ctx),
		},
	},
};

export default plugin;
