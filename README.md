# Gradient Circuit

F1モナコGPのサーキットを、高低差を含めて再現し、その上を周回できる最低限のドライビングシミュレータ。

## 概要

- FastF1のテレメトリデータからモナコサーキットのコースデータ(センターライン・道幅・高低差・曲率)を生成
- ブラウザ(Three.js)上でスロットル操作のみによる周回シミュレーションを実行
- コースデータ生成(Python)とシミュレータ(TypeScript/Three.js)を疎結合な中間形式(JSON)で接続し、将来の別エンジンへの移植を考慮

## 構成

```
gradient-circuit/
├── tools/   # コースデータ生成 (Python + FastF1)
└── web/     # 周回シミュレータ (Vite + TypeScript + Three.js)
```

## セットアップ

### コースデータ生成 (tools/)

```bash
cd tools
uv sync
```

Python 3.12 以上、[uv](https://docs.astral.sh/uv/) が必要です。

### シミュレータ (web/)

準備中(P2 完了後に記載)。

## コースデータの再生成

同梱の `web/public/course/monaco.json` は FastF1 のモナコ GP 決勝データから生成済みです。再生成する場合:

```bash
cd tools
uv run gradient-circuit generate --out ../web/public/course/monaco.json
```

- セッションは既定で自動選択されます(現在年から遡り、位置データが取得できる最新のモナコ GP 決勝)。`--year 2026` のように明示指定も可能です。
- 初回実行時は FastF1 が API からデータを取得するため数分かかります。取得結果は `tools/.fastf1cache/`(Git 管理外)にキャッシュされます。
- 実行後、コースデータが `02_design.md` §7 の受け入れ基準(全長・標高差・道幅・閉合誤差・曲率連続性・欠損値)を満たすか自動検証し、結果をコンソールに出力します。

### テスト

```bash
cd tools
uv run pytest
```

FastF1 への通信を伴わない、幾何計算(曲率符号・弧長リサンプル・道幅クランプ・受け入れ基準判定)のユニットテストです。

## ライセンス

準備中。
