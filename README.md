# Bluesky Feed

An EmDash plugin that copies your own Bluesky posts into a collection on your site, so your theme can show them next to your posts.

Every five minutes it reads your public author feed from `public.api.bsky.app` (no login, no app password), skips replies and reposts, and saves each new post as an entry, then publishes it. Publishing purges the collection's cache tag, so cached pages pick the post up on the next request. It saves at most three new posts per run and picks up the rest on later runs.

The plugin only stores the posts. How they look on the site is up to your theme: query the collection like any other.

## Setup

1. Create a collection (default slug `bluesky`) with these fields:

   | Field       | Type     | Contents                                                        |
   | ----------- | -------- | --------------------------------------------------------------- |
   | `title`     | string   | The first line of the post, shortened (for the admin list)      |
   | `text`      | text     | The post text                                                   |
   | `segments`  | json     | The text split at links, mentions and hashtags: `[{ text, href? }]` |
   | `post_url`  | string   | `https://bsky.app/profile/<handle>/post/<rkey>`                 |
   | `post_uri`  | string   | The post's `at://` URI                                          |
   | `posted_at` | datetime | When the post was written                                       |
   | `images`    | json     | Up to four `{ thumb, fullsize, alt, width, height }` (a video shows its poster frame) |
   | `link_card` | json     | `{ url, title, description, thumb }` or `null`                  |
   | `langs`     | json     | The post's languages, such as `["ja"]`                          |

   With the EmDash CLI:

   ```sh
   npx emdash schema create bluesky --label "Bluesky"
   npx emdash schema add-field bluesky title --type string
   npx emdash schema add-field bluesky text --type text
   npx emdash schema add-field bluesky segments --type json
   npx emdash schema add-field bluesky post_url --type string
   npx emdash schema add-field bluesky post_uri --type string
   npx emdash schema add-field bluesky posted_at --type datetime
   npx emdash schema add-field bluesky images --type json
   npx emdash schema add-field bluesky link_card --type json
   npx emdash schema add-field bluesky langs --type json
   ```

2. Install the plugin and open its settings in the admin.
3. Enter your Bluesky handle (such as `name.bsky.social`). Change the collection only if you used another slug.

If the collection or a field is missing, the plugin logs a warning and writes nothing.

## Capabilities

| Capability                                    | Why                                            |
| --------------------------------------------- | ---------------------------------------------- |
| `network:request` (`public.api.bsky.app` only) | Read your public author feed                   |
| `schema:read`                                 | Check the collection has the fields it writes  |
| `content:write`                               | Save each new post as an entry                 |
| `content:publish`                             | Publish the saved entry                        |

## Routes

- `POST /_emdash/api/plugins/bluesky-feed/sync` (admin only): run a sync now. Returns `{ status, created, remaining }`.

## Development

```sh
npm install
npm test        # validate the manifest, then run the tests in the sandbox
npm run build
```
