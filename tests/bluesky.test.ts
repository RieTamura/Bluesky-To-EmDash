import { describe, expect, it } from "vitest";

import { ownPosts, parsePost, segmentsOf } from "../src/bluesky";

const base = {
	uri: "at://did:plc:example/app.bsky.feed.post/abc",
	author: { did: "did:plc:example", handle: "example.bsky.social" },
	record: { text: "hello", createdAt: "2026-10-27T10:00:00.000Z" },
};

describe("parsePost", () => {
	it("reads images, alt text and aspect ratio", () => {
		const parsed = parsePost({
			post: {
				...base,
				embed: {
					$type: "app.bsky.embed.images#view",
					images: [
						{ thumb: "https://cdn.bsky.app/t", fullsize: "https://cdn.bsky.app/f", alt: "猫", aspectRatio: { width: 4, height: 3 } },
					],
				},
			},
		});
		expect(parsed?.fields.images).toEqual([
			{ thumb: "https://cdn.bsky.app/t", fullsize: "https://cdn.bsky.app/f", alt: "猫", width: 4, height: 3 },
		]);
	});

	it("reads a link card, also inside a quote with media", () => {
		const external = { uri: "https://example.com/", title: "Example", description: "An example", thumb: "https://cdn.bsky.app/x" };
		const direct = parsePost({ post: { ...base, embed: { $type: "app.bsky.embed.external#view", external } } });
		const nested = parsePost({
			post: { ...base, embed: { $type: "app.bsky.embed.recordWithMedia#view", media: { external } } },
		});
		const card = { url: "https://example.com/", title: "Example", description: "An example", thumb: "https://cdn.bsky.app/x" };
		expect(direct?.fields.link_card).toEqual(card);
		expect(nested?.fields.link_card).toEqual(card);
	});

	it("shortens the title to the first line", () => {
		const text = `${"あ".repeat(50)}\n二行目`;
		const parsed = parsePost({ post: { ...base, record: { ...base.record, text } } });
		expect(parsed?.fields.title).toBe(`${"あ".repeat(40)}…`);
	});

	it("skips items without the fields it needs", () => {
		expect(parsePost({ post: { ...base, uri: undefined } })).toBeNull();
		expect(parsePost({ post: { ...base, record: { text: "x", createdAt: "not a date" } } })).toBeNull();
	});
});

describe("ownPosts", () => {
	it("drops reposts and replies and sorts newest first", () => {
		const posts = ownPosts([
			{ post: { ...base, uri: "at://x/app.bsky.feed.post/old", record: { ...base.record, createdAt: "2026-10-01T00:00:00Z" } } },
			{ post: { ...base, uri: "at://x/app.bsky.feed.post/new" } },
			{ post: { ...base, uri: "at://x/app.bsky.feed.post/rp" }, reason: {} },
			{ post: { ...base, uri: "at://x/app.bsky.feed.post/re" }, reply: {} },
		]);
		expect(posts.map((post) => post.rkey)).toEqual(["new", "old"]);
	});
});

describe("segmentsOf", () => {
	it("splits Japanese text at byte offsets", () => {
		const text = "日本語 #タグ と https://example.com";
		const bytes = (s: string) => new TextEncoder().encode(s).length;
		const tagStart = bytes("日本語 ");
		const tagEnd = tagStart + bytes("#タグ");
		const linkStart = bytes("日本語 #タグ と ");
		const segments = segmentsOf(text, [
			{ index: { byteStart: linkStart, byteEnd: bytes(text) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }] },
			{ index: { byteStart: tagStart, byteEnd: tagEnd }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "タグ" }] },
		]);
		expect(segments).toEqual([
			{ text: "日本語 " },
			{ text: "#タグ", href: "https://bsky.app/hashtag/%E3%82%BF%E3%82%B0" },
			{ text: " と " },
			{ text: "https://example.com", href: "https://example.com" },
		]);
	});

	it("ignores links that are not http(s)", () => {
		const segments = segmentsOf("click", [
			{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }] },
		]);
		expect(segments).toEqual([{ text: "click" }]);
	});
});
