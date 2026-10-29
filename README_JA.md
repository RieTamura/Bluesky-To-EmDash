# Bluesky Feed

自分の Bluesky の投稿を、EmDash のサイトのコレクションにコピーするプラグインです。テーマから読み出して、記事と並べて表示できます。

5 分ごとに `public.api.bsky.app` から自分の公開フィードを読み（ログインもアプリパスワードも要りません）、返信とリポストを除いて、新しい投稿をエントリーとして保存し、公開します。公開するとコレクションのキャッシュが消えるので、次に開いたときに新しい投稿が出ます。サンドボックスの制限（1 回の実行で通信 10 回まで）に収まるよう、1 回に保存するのは 1 件で、残りは次の回に回します。管理画面で消した投稿は、もう一度保存されることはありません。

プラグインは投稿を保存するだけです。サイトでの見せ方はテーマ次第で、ほかのコレクションと同じように読み出せます。

[English README](README.md)

## 入れ方

EmDash のプラグインレジストリから入れる場合は、管理画面で **Bluesky Feed** をインストールします。レジストリのプラグインはサンドボックスの中で動くので、Cloudflare では Workers の有料プランが必要です。

GitHub から入れて、`astro.config.mjs` でサイトの中で動かすこともできます。この場合はサンドボックスが要りません。インストールのときに自動でビルドされます。

```sh
npm install github:RieTamura/Bluesky-To-EmDash
```

```js
import blueskyFeed from "bluesky-feed";

emdash({
	// ...
	plugins: [blueskyFeed],
});
```

## 設定

1. 次の項目を持つコレクションを作ります（名前の初期値は `bluesky`）。

   | 項目        | 種類     | 中身                                                     |
   | ----------- | -------- | -------------------------------------------------------- |
   | `title`     | string   | 投稿の 1 行目を短くしたもの（管理画面の一覧用）          |
   | `text`      | text     | 投稿の本文                                               |
   | `segments`  | json     | 本文をリンク・メンション・ハッシュタグで区切ったもの：`[{ text, href? }]` |
   | `post_url`  | string   | `https://bsky.app/profile/<handle>/post/<rkey>`          |
   | `post_uri`  | string   | 投稿の `at://` URI                                       |
   | `posted_at` | datetime | 投稿した日時                                             |
   | `images`    | json     | 最大 4 枚の `{ thumb, fullsize, alt, width, height }`（動画はサムネイル） |
   | `link_card` | json     | `{ url, title, description, thumb }` または `null`       |
   | `langs`     | json     | 投稿の言語（例：`["ja"]`）                               |

   EmDash の CLI で作る場合：

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

2. プラグインを入れて、管理画面でプラグインの設定を開きます。
3. Bluesky のハンドル（例：`name.bsky.social`）を入れます。コレクションの名前は、別の名前で作ったときだけ変えます。

コレクションや項目が足りないときは、警告をログに出して、何も書き込みません。

## 使う権限

| 権限                                            | 使い道                                   |
| ----------------------------------------------- | ---------------------------------------- |
| `network:request`（`public.api.bsky.app` だけ） | 自分の公開フィードを読む                 |
| `schema:read`                                   | コレクションに必要な項目があるか確かめる |
| `content:write`                                 | 新しい投稿をエントリーとして保存する     |
| `content:publish`                               | 保存したエントリーを公開する             |

## API

- `POST /_emdash/api/plugins/bluesky-feed/sync`（管理者だけ）：今すぐ同期します。`{ status, created, published, duplicatesRemoved, remaining }` を返します。

## 開発

```sh
npm install
npm test           # manifest を確かめてから、サンドボックスでテストする
npm run typecheck
npm run build
```

新しい版を出すときは `package.json` の `version` を上げます。`emdash-plugin.jsonc` には `version` を書かず、ビルドのときに `package.json` から読みます。

## 問題の報告

<https://github.com/RieTamura/Bluesky-To-EmDash/issues> に Issue を立ててください。セキュリティの問題のときは、タイトルにそう書いて、詳しい内容は書かないでください。内容を非公開で送る方法をお返事します。

## ライセンス

MIT
