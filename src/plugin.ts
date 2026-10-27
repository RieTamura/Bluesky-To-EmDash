import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { authorFeedUrl, type FeedItem, ownPosts, REQUIRED_FIELDS } from "./bluesky";

const DEFAULT_COLLECTION = "bluesky";
const CRON_TASK = "sync";
const CRON_SCHEDULE = "*/5 * * * *";
/** How many recent posts to look at on each run. */
const FETCH_LIMIT = 30;
/**
 * How many posts to save or publish on each run. Each one takes a few host
 * calls, and the Cloudflare sandbox allows few subrequests per invocation;
 * the rest are picked up on the next run.
 */
const MAX_PER_RUN = 3;
/**
 * Time limit for one scheduled run. The host's default is 5 seconds, which
 * a run that saves and publishes a few posts can exceed when the database
 * is far away.
 */
const CRON_TIMEOUT_MS = 25_000;

/** What the plugin remembers about a post it has saved, keyed by record key. */
interface SyncedPost {
	contentId: string;
	postedAt: string;
	/** Set once the entry is published, or found gone; a saved draft is retried. */
	published?: boolean;
}

type SyncResult =
	| { status: "ok"; created: number; published: number; remaining: number }
	| { status: "not_configured" }
	| { status: "collection_invalid"; collection: string; problems: string[] }
	| { status: "fetch_failed"; httpStatus: number };

async function scheduleSync(ctx: PluginContext) {
	await ctx.cron?.schedule(CRON_TASK, { schedule: CRON_SCHEDULE });
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

async function sync(ctx: PluginContext): Promise<SyncResult> {
	const actor = normalizeActor(await ctx.settings.get("handle"));
	if (!actor) return { status: "not_configured" };
	const collectionSetting = await ctx.settings.get<string>("collection");
	const collection = collectionSetting?.trim() || DEFAULT_COLLECTION;

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
	const known = await synced.getMany(posts.map((post) => post.rkey));
	// Saved by an earlier run that stopped before publishing.
	const drafts = posts.flatMap((post) => {
		const record = known.get(post.rkey) as SyncedPost | undefined;
		return record && !record.published ? [{ rkey: post.rkey, record }] : [];
	});
	const pending = posts.filter((post) => !known.has(post.rkey));

	const content = ctx.content!;
	let budget = MAX_PER_RUN;
	let published = 0;
	for (const { rkey, record } of drafts.slice(0, budget)) {
		budget--;
		if (await publishSaved(ctx, collection, rkey, record)) published++;
	}

	let created = 0;
	for (const post of pending.slice(0, budget)) {
		const item = await content.create!(collection, { ...post.fields });
		const record: SyncedPost = { contentId: item.id, postedAt: post.fields.posted_at };
		// Remember it before publishing, so a failed publish never leads to a duplicate.
		await synced.put(post.rkey, record);
		created++;
		if (await publishSaved(ctx, collection, post.rkey, record)) published++;
	}

	await ctx.kv.set("state:lastSync", new Date().toISOString());
	return { status: "ok", created, published, remaining: pending.length - created };
}

/**
 * Publishes a saved entry and records that it is done. Returns false if
 * it could not be published; the next run tries again.
 */
async function publishSaved(
	ctx: PluginContext,
	collection: string,
	rkey: string,
	record: SyncedPost,
): Promise<boolean> {
	const content = ctx.content!;
	try {
		const versioned = await content.getVersioned!(collection, record.contentId);
		// Deleted in the admin: leave it deleted.
		if (versioned && versioned.item.status !== "published") {
			await content.publish!(collection, record.contentId, { _rev: versioned._rev });
		}
		await ctx.storage.posts!.put(rkey, { ...record, published: true } satisfies SyncedPost);
		return !!versioned;
	} catch (error) {
		ctx.log.error("Saved a Bluesky post but could not publish it", {
			contentId: record.contentId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => scheduleSync(ctx),
		"plugin:activate": async (_event, ctx) => scheduleSync(ctx),
		cron: {
			timeout: CRON_TIMEOUT_MS,
			handler: async (event, ctx) => {
				if (event.name !== CRON_TASK) return;
				const result = await sync(ctx);
				if (result.status === "ok" && (result.created > 0 || result.published > 0)) {
					ctx.log.info("Saved new Bluesky posts", result);
				}
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
