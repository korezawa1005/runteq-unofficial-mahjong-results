# RUNTEQ非公式麻雀サークル：成績表

RUNTEQコミュニティの麻雀仲間で、四人麻雀の半荘結果を記録・共有するためのWebアプリです。

4人の順位と終了時点数を登録すると、個人成績やランキングが自動で集計されます。

> [!NOTE]
> このアプリは個人が制作した非公式アプリであり、RUNTEQ公式のサービスではありません。

**公開アプリ：** [RUNTEQ非公式麻雀サークル：成績表を開く](https://runteq-unofficial-mahjong-results.runteq-mahjong-circle.workers.dev)

## 主な機能

### 成績を見る

- 年別・通算の個人成績
- ゲーム数、トップ回数、平均着順
- トップ率、連対率、ラス回避率、飛び回避率
- 1〜4位の回数と割合
- 直近10半荘の着順推移グラフ
- 当日の参加者ごとの半荘数、平均着順、1位回数

### ランキングを見る

以下の指標ごとにメンバーを並べ替えられます。

- 平均着順
- トップ率
- 連対率
- ラス回避率
- 飛び回避率

正式ランキングの規定対局数は、選択期間内で10半荘です。10半荘未満の成績も確認できますが、順位を付けず参考記録として表示します。

### 対局を管理する

管理者PINでロックを解除すると、次の操作ができます。

- メンバーの登録・名前変更・非表示
- 対局結果の登録・編集・削除
- 入力内容を確認してから保存
- 同一メンバーの重複、点数合計、順位と点数の矛盾を検証
- 同じ日時・同じ4人による重複登録の警告
- 年・メンバーによる対局履歴の絞り込み
- 共通アクセスPINの設定
- JSON形式でのバックアップ・復元

一般利用者は、個人成績・ランキング・対局履歴を閲覧できます。対局やメンバーを変更できるのは管理者だけです。

## 対局結果の入力ルール

- 四人麻雀の半荘として4人分を入力します。
- 順位は1〜4位の行で指定します。
- 終了時点数は100点単位で入力します。
- 4人の点数合計は100,000点にします。
- 点数が高い人を上位にします。
- 同点の場合は、画面で上に置いた人を上位として記録できます。

## 画面構成

| 画面 | 内容 |
| --- | --- |
| 成績 | 個人成績、着順推移、着順内訳、当日の成績を表示 |
| ランキング | 指標を切り替えて全メンバーを比較 |
| 対局を記録 | 管理者が順位と終了時点数を登録 |
| 対局履歴 | 保存した対局を検索・確認。管理者は編集・削除が可能 |
| メンバー | 登録メンバーと管理設定を確認 |

## 技術構成

| 分類 | 使用技術 |
| --- | --- |
| フロントエンド | HTML / CSS / Vanilla JavaScript |
| 本番API | Cloudflare Workers |
| 本番データベース | Cloudflare D1 |
| ローカルAPI | Python標準ライブラリ |
| ローカルデータベース | SQLite |
| デプロイ | Wrangler |

本番環境では、静的ファイルをCloudflare Workers Assetsから配信し、`/api/*` をWorkerで処理します。

## ローカルで起動する

### 必要なもの

- Python 3
- モダンブラウザ

### 手順

```sh
git clone https://github.com/korezawa1005/runteq-unofficial-mahjong-results.git
cd runteq-unofficial-mahjong-results
python3 start_local.py
```

ブラウザで <http://127.0.0.1:8010> を開きます。

ローカルデータは `data/results.sqlite3` に保存されます。`data/` はGitの管理対象外です。

初回は「メンバー」画面で、管理操作に使用する4〜12桁の管理者PINを設定してください。共通アクセスPINを設定すると、アプリを開く一般利用者にもPIN入力を求められます。同じ端末では、認証後30日間入力を省略します。

## テスト

変更内容に応じた確認方針は [DEVELOPMENT.md](DEVELOPMENT.md) に記載しています。

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_stats.js
```

ブラウザテストを実行する場合は、事前に依存パッケージとChromeを用意します。

```sh
npm install
npx playwright install chrome
npm run test:e2e
```

## Cloudflareへデプロイする

### 初回セットアップ

Node.jsを用意して、依存パッケージをインストールします。

```sh
npm install
npx wrangler login
```

自分のCloudflareアカウントでD1データベースを作成します。

```sh
npx wrangler d1 create runteq-unofficial-mahjong-results-db
```

表示された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に設定した後、テーブルを作成してデプロイします。

```sh
npm run db:migrate:remote
npm run deploy
```

### ローカルデータをD1へ移行する

ローカルSQLiteのデータを移行する場合は、移行用SQLを生成してD1へ適用します。

```sh
python3 scripts/export_d1.py
npx wrangler d1 execute DB --remote --file data/d1-import.sql --yes
```

生成されるSQLには、メンバー、対局、結果、管理者PINと共通PINのハッシュが含まれます。PINそのもの、ログインセッション、PIN入力履歴は含まれません。

メンバーとPIN設定だけを移行し、対局結果を含めない場合は次のコマンドを使います。

```sh
python3 scripts/export_d1.py --without-results --output data/d1-without-results.sql
```

### 管理者PINを忘れた場合

Cloudflareへログイン済みの環境で、次のスクリプトを実行すると本番D1の管理者PINを再設定できます。

```sh
python3 scripts/reset_admin_pin.py
```

## データとアクセス管理

- 管理者PINと共通アクセスPINは、PBKDF2でハッシュ化して保存します。
- PINの連続試行には回数制限があります。
- 認証セッションはCookieで管理します。
- JSONバックアップにはメンバーと全対局を含みますが、PINやログイン情報は含みません。
- このリポジトリには、本番D1の対局データや実際のPINは含まれません。

仲間内での利用を想定した小規模アプリです。機密情報や強い本人確認が必要な用途では、専用の認証基盤を追加してください。

## キャラクター素材

画面内の「らんてくん」画像は、[RUNTEQ公式ブログ](https://runteq.jp/blog/programing_school/teacher/1059/)掲載素材を使用しています。
