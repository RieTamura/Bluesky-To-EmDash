/**
 * Turns Bluesky's public `app.bsky.feed.getAuthorFeed` response into the
 * field values the plugin stores. Pure functions, no plugin context, so
 * they are easy to test on their own.
 */

export const BLUESKY_API = "https://public.api.bsky.app/xrpc";

/** The parts of a feed item this plugin reads. Everything is optional: it's someone else's API. */
export interface FeedItem {
	post?: {
		uri?: string;
		author?: { did?: string; handle?: string };
		record?: {
			text?: string;
			createdAt?: string;
			langs?: string[];
			reply?: unknown;
			facets?: Facet[];
		};
		embed?: EmbedView;
	};
	reply?: unknown;
	reason?: unknown;
}

interface Facet {
	index?: { byteStart?: number; byteEnd?: number };
	features?: Array<{ $type?: string; uri?: string; did?: string; tag?: string }>;
}

interface ImageView {
	thumb?: string;
	fullsize?: string;
	alt?: string;
	aspectRatio?: { width?: number; height?: number };
}

interface EmbedView {
	$type?: string;
	images?: ImageView[];
	external?: { uri?: string; title?: string; description?: string; thumb?: string };
	thumbnail?: string;
	alt?: string;
	aspectRatio?: { width?: number; height?: number };
	media?: EmbedView;
}

export interface PostImage {
	thumb: string;
	fullsize: string;
	alt: string;
	width: number | null;
	height: number | null;
}

export interface LinkCard {
	url: string;
	title: string;
	description: string;
	thumb: string | null;
}

/** A run of post text. `href` is set for links, mentions and hashtags. */
export interface TextSegment {
	text: string;
	href?: string;
}

/** Field values for one entry in the target collection. */
export interface PostFields {
	title: string;
	text: string;
	segments: TextSegment[];
	post_url: string;
	post_uri: string;
	posted_at: string;
	images: PostImage[];
	link_card: LinkCard | null;
	langs: string[];
}

export interface ParsedPost {
	/** The record key: the last part of the post's at:// URI. */
	rkey: string;
	fields: PostFields;
}

/** Fields the target collection must have, with the types the plugin writes. */
export const REQUIRED_FIELDS: Record<keyof PostFields, string> = {
	title: "string",
	text: "text",
	segments: "json",
	post_url: "string",
	post_uri: "string",
	posted_at: "datetime",
	images: "json",
	link_card: "json",
	langs: "json",
};

const TITLE_LENGTH = 40;

export function authorFeedUrl(actor: string, limit: number): string {
	const params = new URLSearchParams({
		actor,
		limit: String(limit),
		filter: "posts_no_replies",
	});
	return `${BLUESKY_API}/app.bsky.feed.getAuthorFeed?${params}`;
}

/**
 * The author's own top-level posts, newest first: no reposts (they carry a
 * `reason`) and no replies (the API filter already drops most; a reply in
 * the record is the final check).
 */
export function ownPosts(feed: FeedItem[]): ParsedPost[] {
	const posts: ParsedPost[] = [];
	for (const item of feed) {
		if (item.reason || item.reply || item.post?.record?.reply) continue;
		const parsed = parsePost(item);
		if (parsed) posts.push(parsed);
	}
	return posts.sort((a, b) => b.fields.posted_at.localeCompare(a.fields.posted_at));
}

export function parsePost(item: FeedItem): ParsedPost | null {
	const post = item.post;
	const uri = post?.uri;
	const handle = post?.author?.handle;
	const createdAt = post?.record?.createdAt;
	if (!uri || !handle || !createdAt) return null;

	const rkey = uri.split("/").pop();
	const postedAt = new Date(createdAt);
	if (!rkey || Number.isNaN(postedAt.getTime())) return null;

	const text = post.record?.text ?? "";
	const images = imagesOf(post.embed);
	return {
		rkey,
		fields: {
			title: titleOf(text, images.length > 0),
			text,
			segments: segmentsOf(text, post.record?.facets ?? []),
			post_url: `https://bsky.app/profile/${handle}/post/${rkey}`,
			post_uri: uri,
			posted_at: postedAt.toISOString(),
			images,
			link_card: linkCardOf(post.embed),
			langs: post.record?.langs ?? [],
		},
	};
}

/** The first line of the text, shortened, for the admin list. */
function titleOf(text: string, hasImages: boolean): string {
	const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) return hasImages ? "(画像)" : "(本文なし)";
	const chars = [...firstLine];
	return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH).join("")}…` : firstLine;
}

function imagesOf(embed: EmbedView | undefined): PostImage[] {
	if (!embed) return [];
	if (embed.media) return imagesOf(embed.media);
	if (embed.images) {
		return embed.images.flatMap((image) =>
			image.thumb && image.fullsize
				? [
						{
							thumb: image.thumb,
							fullsize: image.fullsize,
							alt: image.alt ?? "",
							width: image.aspectRatio?.width ?? null,
							height: image.aspectRatio?.height ?? null,
						},
					]
				: [],
		);
	}
	// A video: show its poster frame; the visitor plays it on Bluesky.
	if (embed.thumbnail) {
		return [
			{
				thumb: embed.thumbnail,
				fullsize: embed.thumbnail,
				alt: embed.alt ?? "",
				width: embed.aspectRatio?.width ?? null,
				height: embed.aspectRatio?.height ?? null,
			},
		];
	}
	return [];
}

function linkCardOf(embed: EmbedView | undefined): LinkCard | null {
	const external = embed?.media?.external ?? embed?.external;
	if (!external?.uri) return null;
	return {
		url: external.uri,
		title: external.title ?? "",
		description: external.description ?? "",
		thumb: external.thumb ?? null,
	};
}

/**
 * Splits the text at its facets. Facet offsets count UTF-8 bytes, not
 * characters, so the slicing happens on the encoded bytes.
 */
export function segmentsOf(text: string, facets: Facet[]): TextSegment[] {
	const bytes = new TextEncoder().encode(text);
	const decoder = new TextDecoder();
	const sorted = facets
		.map((facet) => ({
			start: facet.index?.byteStart ?? -1,
			end: facet.index?.byteEnd ?? -1,
			href: hrefOf(facet),
		}))
		.filter((facet) => facet.href && facet.start >= 0 && facet.end > facet.start)
		.sort((a, b) => a.start - b.start);

	const segments: TextSegment[] = [];
	let cursor = 0;
	for (const facet of sorted) {
		if (facet.start < cursor || facet.end > bytes.length) continue;
		if (facet.start > cursor) {
			segments.push({ text: decoder.decode(bytes.slice(cursor, facet.start)) });
		}
		segments.push({ text: decoder.decode(bytes.slice(facet.start, facet.end)), href: facet.href });
		cursor = facet.end;
	}
	if (cursor < bytes.length) segments.push({ text: decoder.decode(bytes.slice(cursor)) });
	return segments;
}

function hrefOf(facet: Facet): string | undefined {
	for (const feature of facet.features ?? []) {
		switch (feature.$type) {
			case "app.bsky.richtext.facet#link":
				if (feature.uri && /^https?:\/\//i.test(feature.uri)) return feature.uri;
				break;
			case "app.bsky.richtext.facet#mention":
				if (feature.did) return `https://bsky.app/profile/${feature.did}`;
				break;
			case "app.bsky.richtext.facet#tag":
				if (feature.tag) return `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`;
				break;
		}
	}
	return undefined;
}
