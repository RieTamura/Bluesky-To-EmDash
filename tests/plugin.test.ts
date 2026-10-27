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

	it("saves a few posts per run, newest first, and the rest on later runs", async () => {
		const h = await setup();
		const feed = ["p1", "p2", "p3", "p4", "p5"].map((rkey, i) =>
			feedPost(rkey, `2026-10-2${i + 1}T10:00:00.000Z`),
		);
		await h.http.respond(FEED_URL, feedResponse(feed));
		const first = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(first).toEqual({ status: "ok", created: 3, published: 3, remaining: 2 });
		const saved = (await h.inspect.storage.list("posts")).map((entry) => entry.id).sort();
		expect(saved).toEqual(["p3", "p4", "p5"]);

		await h.http.respond(FEED_URL, feedResponse(feed));
		const second = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(second).toEqual({ status: "ok", created: 2, published: 2, remaining: 0 });
		expect(await h.inspect.content.list("bluesky")).toHaveLength(5);
	});

	it("publishes a post an earlier run saved but did not publish", async () => {
		const h = await setup();
		const draft = await h.fixtures.content("bluesky", {
			slug: "aaa",
			data: { title: "post aaa", text: "post aaa", posted_at: "2026-10-27T10:00:00.000Z" },
		});
		expect(draft.status).not.toBe("published");
		await h.fixtures.plugin.storage("posts", "aaa", {
			contentId: draft.id,
			postedAt: "2026-10-27T10:00:00.000Z",
		});
		await h.http.respond(FEED_URL, feedResponse([feedPost("aaa", "2026-10-27T10:00:00.000Z")]));

		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });

		expect(result).toEqual({ status: "ok", created: 0, published: 1, remaining: 0 });
		expect((await h.inspect.content.get("bluesky", draft.id))?.status).toBe("published");
		expect(await h.inspect.content.list("bluesky")).toHaveLength(1);
		expect(await h.inspect.storage.get("posts", "aaa")).toMatchObject({ published: true });
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

	it("reports a failed Bluesky request", async () => {
		const h = await setup();
		await h.http.respond(FEED_URL, new Response("busy", { status: 503 }));
		const result = await h.transport.invokeRoute("sync", {}, { method: "POST" });
		expect(result).toEqual({ status: "fetch_failed", httpStatus: 503 });
		expect(await h.inspect.content.list("bluesky")).toHaveLength(0);
	});
});
