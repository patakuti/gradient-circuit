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

```bash
cd web
npm install
npm run dev
```

Node.js 18 以上が必要です。`npm run dev` 後、表示された URL(既定 http://localhost:5173/)をブラウザで開きます。画面左下のスライダー、またはキーボードの ↑ / W でスロットル操作ができ、コースを周回できます。`C` キーでチェイスカメラ(後方追従)とコックピットカメラ(運転席目線)を切り替えられます。1 周完了するとブラウザの開発者コンソールにログが出力されます。ブレーキ・コーナリング速度制限は初期スコープ外です(要求 4.2)。

`npm run build` で `web/dist/` に本番ビルドを出力します。`npm run lint` で ESLint を実行します(`sim/` 配下から `three` を import すると検出されます)。

## コースデータの再生成

同梱の `web/public/course/monaco.json` は FastF1 のモナコ GP 決勝データから生成済みです。再生成する場合:

```bash
cd tools
uv run gradient-circuit generate --out ../web/public/course/monaco.json
```

- セッションは既定で自動選択されます(現在年から遡り、位置データが取得できる最新のモナコ GP 決勝)。`--year 2026` のように明示指定も可能です。
- 初回実行時は FastF1 が API からデータを取得するため数分かかります。取得結果は `tools/.fastf1cache/`(Git 管理外)にキャッシュされます。
- 実行後、コースデータが以下の受け入れ基準を満たすか自動検証し、結果をコンソールに出力します: 全長 3337m±3%、標高差 40m±15%、全幅 8〜12m、ループ閉合誤差 <1.0m、曲率の連続性、欠損値なし、サンプル配列長の整合性。

### テスト

```bash
cd tools
uv run pytest
```

FastF1 への通信を伴わない、幾何計算(曲率符号・弧長リサンプル・道幅クランプ・受け入れ基準判定)のユニットテストです。

## 別エンジンへの移植について

`web/public/course/monaco.json` は Three.js に固有の情報を一切含まない、エンジン非依存の中間形式(`gradient-circuit/course@1`)です。座標は Z 上・右手系(Three.js の Y 上への変換は `web/src/course/loader.ts` が担当)。この JSON をそのまま読み込めば、Unity など別エンジンでも同じコースデータを利用できます。

| 再実装が必要 | そのまま流用可 |
|---|---|
| `web/src/render/*`(Three.js 固有の描画) | `web/public/course/monaco.json`(データそのもの) |
| `web/src/ui/*`(DOM 固有の HUD/操作) | `web/src/sim/track.ts` / `sim/vehicle.ts` のアルゴリズム(純粋な数式のみ、`three` 非依存。ESLint で機械的に強制) |
| `web/src/camera/*Rig`(カメラ API 固有) | `web/src/camera/types.ts` のインタフェース定義 |

## ライセンス

準備中。
