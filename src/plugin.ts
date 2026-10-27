import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { authorFeedUrl, type FeedItem, ownPosts, REQUIRED_FIELDS } from "./bluesky";

const DEFAULT_COLLECTION = "bluesky";
const CRON_TASK = "sync";
const CRON_SCHEDULE = "*/5 * * * *";
/** How many recent posts to look at on each run. */
const FETCH_LIMIT = 30;
/**
 * How many new posts to save on each run. Each one takes three host calls,
 * and the Cloudflare sandbox allows few subrequests per invocation; the
 * rest are picked up on the next run.
 */
const MAX_PER_RUN = 3;

/** What the plugin remembers about a post it has saved, keyed by record key. */
interface SyncedPost {
	contentId: string;
	postedAt: string;
}

type SyncResult =
	| { status: "ok"; created: number; remaining: number }
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
	const pending = posts.filter((post) => !known.has(post.rkey));

	const content = ctx.content!;
	let created = 0;
	for (const post of pending.slice(0, MAX_PER_RUN)) {
		const item = await content.create!(collection, { ...post.fields });
		// Remember it before publishing, so a failed publish never leads to a duplicate.
		await synced.put(post.rkey, { contentId: item.id, postedAt: post.fields.posted_at } satisfies SyncedPost);
		created++;
		try {
			const versioned = await content.getVersioned!(collection, item.id);
			if (!versioned) throw new Error("created entry not found");
			await content.publish!(collection, item.id, { _rev: versioned._rev });
		} catch (error) {
			ctx.log.error("Saved a Bluesky post but could not publish it", {
				contentId: item.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	await ctx.kv.set("state:lastSync", new Date().toISOString());
	return { status: "ok", created, remaining: pending.length - created };
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => scheduleSync(ctx),
		"plugin:activate": async (_event, ctx) => scheduleSync(ctx),
		cron: async (event, ctx) => {
			if (event.name !== CRON_TASK) return;
			const result = await sync(ctx);
			if (result.status === "ok" && result.created > 0) {
				ctx.log.info("Saved new Bluesky posts", result);
			}
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
