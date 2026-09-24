# RUNTEQ麻雀サークル：成績表

RUNTEQ麻雀サークルの四人麻雀・半荘の順位と終了時点数を記録し、個人成績を表示するWebアプリです。

## 起動

```sh
cd simple_app
python3 start_local.py
```

ブラウザで `http://127.0.0.1:8010` を開きます。データは `simple_app/data/results.sqlite3` に保存されます。

初回は「メンバー」画面で4〜12桁の管理者PINを設定します。一般メンバーは対局登録と成績閲覧、管理者はメンバー追加・名前変更・非表示・対局削除を行えます。

## テスト

変更内容に応じた確認範囲は [DEVELOPMENT.md](DEVELOPMENT.md) に記載しています。

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_stats.js
```

ブラウザテストを実行する場合だけ、`npm install` と `npx playwright install chrome` を実行します。
