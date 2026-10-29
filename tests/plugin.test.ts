import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import { authorFeedUrl, REQUIRED_FIELDS } from "../src/bluesky";

const HANDLE = "example.bsky.social";
const DID = "did:plc:example";
const FEED_URL = authorFeedUrl(HANDLE, 30);

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

function feedPost(rkey: string, createdAt: string, extra: Record<string, unknown> = {}) {
	return {
		post: {
			uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
			author: { did: DID, handle: HANDLE },
			record: { text: `post ${rkey}`, createdAt, langs: ["ja"] },
			...extra,
		},
	};
}

function feedResponse(feed: unknown[]) {
	return new Response(JSON.stringify({ feed }), {
		headers: { "content-type": "application/json" },
	});
}

async function setup(options: { collection?: boolean; handle?: string | null } = {}) {
	host = await createPluginRuntimeTestHost();
	if (options.collection !== false) {
		await host.fixtures.collection({
			slug: "bluesky",
			label: "Bluesky",
			supports: ["drafts", "revisions"],
			fields: Object.entries(REQUIRED_FIELDS).map(([slug, type]) => ({
				slug,
				label: slug,
				type: type as never,
			})),
		});
	}
	if (options.handle !== null) {
		await host.fixtures.plugin.setting("handle", options.handle ?? HANDLE);
	}
	return host;
}

async function runSync(host: PluginRuntimeTestHost) {
	return host.transport.invokeHook("cron", { name: "sync" });
}

describe("schedule", () => {
	it("schedules the sync task when the plugin is activated", async () => {
		const h = await setup();
		await h.actions.plugin.activate();
		const tasks = await h.inspect.scheduledTasks();
		expect(tasks).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sync", schedule: "*/5 * * * *", enabled: 1 })]),
		);
	});
});

describe("sync", () => {
	it("saves and publishes own posts, skipping replies and reposts", async () => {
		const h = await setup();
		await h.http.respond(
			FEED_URL,
			feedResponse([
				feedPost("aaa", "2026-10-27T10:00:00.000Z"),
				{ ...feedPost("rp1", "2026-10-27T09:00:00.000Z"), reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
				feedPost("re1", "2026-10-27T08:00:00.000Z", {
					record: { text: "a reply", createdAt: "2026-10-27T08:00:00.000Z", reply: { parent: {} } },
				}),
			]),
		);

		await runSync(h);

		const items = await h.inspect.content.list("bluesky");
		expect(items).toHaveLength(1);
		expect(items[0]?.status).toBe("published");
		expect(items[0]?.data).toMatchObject({
			title: "post aaa",
			text: "post aaa",
			post_url: `https://bsky.app/profile/${HANDLE}/post/aaa`,
			post_uri: `at://${DID}/app.bsky.feed.post/aaa`,
		});
		expect(await h.inspect.storage.get("posts", "aaa")).toMatchObject({ contentId: items[0]?.id });
	});

	it("does not save the same post twice", async () => {
		const h = await setup();
		const feed = [feedPost("aaa", "2026-10-27T10:00:00.000Z")];
		await h.http.respond(FEED_URL, feedResponse(feed));
		await runSync(h);
		await h.http.respond(FEED_URL, feedResponse(feed));
		await runSync(h);

		expect(await h.inspect.content.list("bluesky")).toHaveLength(1);
	});

	it("saves one post per run, newest first, and the rest on later runs", async () => {
		const h = await setup();
		const feed = ["p1", "p2", "p3"].map((rkey, i) => feedPost(rkey, `2026-10-2${i + 1}T10:00:00.000Z`));
		const results = [];
		for (let i = 0; i < 4; i++) {
			await h.http.respond(FEED_URL, feedResponse(feed));
			results.push(await h.transport.invokeRoute("sync", {}, { method: "POST" }));
			if (i === 0) {
				expect((await h.inspect.storage.list("posts")).map((entry) => entry.id)).toEqual(["p3"]);
			}
		}
		expect(results.map((r) => (r as { remaining: number }).remaining)).toEqual([2, 1, 0, 0]);
		expect(results.map((r) => (r as { created: number }).created)).toEqual([1, 1, 1, 0]);
		const items = await h.inspect.content.list("bluesky");
		expect(items).toHaveLength(3);
		expect(items.every((item) => item.status === "published")).toBe(true);
	});

	it("publishes a post saved by a run that was cut off before remembering it", async () => {
		const h = await setup();
		const draft = await h.fixtures.content("bluesky", {
			slug: "post-aaa",
			data: { title: "post aaa", text: "post aaa", post_uri: `at://${DID}/app.bsky.feed.post/aaa` },
		});
		expect(draft.status).not.toBe("published");
		await h.http.respond(FEED_URL, feedResponse([feedPost("aaa", "2026-10-27T10:00:00.000Z")]));

		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });

		expect(result).toEqual({ status: "ok", created: 0, published: 1, duplicatesRemoved: 0, remaining: 0 });
		expect((await h.inspect.content.get("bluesky", draft.id))?.status).toBe("published");
		expect(await h.inspect.content.list("bluesky")).toHaveLength(1);
		expect(await h.inspect.storage.get("posts", "aaa")).toMatchObject({ contentId: draft.id });
	});

	it("moves extra copies of a post to the trash one per run, keeping one", async () => {
		const h = await setup();
		const uri = `at://${DID}/app.bsky.feed.post/aaa`;
		const first = await h.fixtures.content("bluesky", { slug: "a-1", data: { title: "a", post_uri: uri } });
		await h.fixtures.content("bluesky", { slug: "a-2", data: { title: "a", post_uri: uri } });
		await h.fixtures.content("bluesky", { slug: "a-3", data: { title: "a", post_uri: uri } });

		const results = [];
		for (let i = 0; i < 3; i++) {
			await h.http.respond(FEED_URL, feedResponse([feedPost("aaa", "2026-10-27T10:00:00.000Z")]));
			results.push(await h.transport.invokeRoute("sync", {}, { method: "POST" }));
		}

		expect(results).toMatchObject([
			{ duplicatesRemoved: 1, published: 0, created: 0 },
			{ duplicatesRemoved: 1, published: 0, created: 0 },
			{ duplicatesRemoved: 0, published: 1, created: 0 },
		]);
		const items = await h.inspect.content.list("bluesky");
		const live = items.filter((item) => item.status !== "trash" && !("deletedAt" in item && item.deletedAt));
		expect(live.map((item) => item.id)).toContain(first.id);
		expect((await h.inspect.content.get("bluesky", first.id))?.status).toBe("published");
	});

	it("does not bring back a post deleted in the admin", async () => {
		const h = await setup();
		await h.fixtures.plugin.storage("posts", "aaa", { contentId: "gone", postedAt: "2026-10-27T10:00:00.000Z" });
		await h.http.respond(FEED_URL, feedResponse([feedPost("aaa", "2026-10-27T10:00:00.000Z")]));

		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });

		expect(result).toMatchObject({ created: 0, remaining: 0 });
		expect(await h.inspect.content.list("bluesky")).toHaveLength(0);
	});

	it("does nothing until a handle is set", async () => {
		const h = await setup({ handle: null });
		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(result).toEqual({ status: "not_configured" });
		expect(h.http.requests()).toHaveLength(0);
	});

	it("reports a missing collection instead of writing", async () => {
		const h = await setup({ collection: false });
		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(result).toMatchObject({ status: "collection_invalid", collection: "bluesky" });
		expect(h.http.requests()).toHaveLength(0);
	});

	it("checks the collection named in the settings", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("collection", " posts_from_bluesky ");
		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(result).toMatchObject({ status: "collection_invalid", collection: "posts_from_bluesky" });
	});

	it("reports a failed Bluesky request", async () => {
		const h = await setup();
		await h.http.respond(FEED_URL, new Response("busy", { status: 503 }));
		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(result).toEqual({ status: "fetch_failed", httpStatus: 503 });
		expect(await h.inspect.content.list("bluesky")).toHaveLength(0);
	});
});
