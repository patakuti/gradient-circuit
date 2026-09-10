# Gradient Circuit

F1サーキット(モナコGP、鈴鹿)を、高低差を含めて再現し、その上を周回できる最低限のドライビングシミュレータ。

## 概要

- FastF1のテレメトリデータからサーキットのコースデータ(センターライン・道幅・高低差・曲率)を生成。モナコ・鈴鹿に対応
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

Node.js 18 以上が必要です。`npm run dev` 後、表示された URL(既定 http://localhost:5173/)をブラウザで開きます。キーボードの ↑ / W でスロットル、↓ / S でブレーキ操作ができ、コースを周回できます。コーナーの手前でブレーキをかけずに進入すると、コースの曲率に応じたグリップ限界を超えた分だけ自動的に減速します。`C` キーでチェイスカメラ(後方追従)とコックピットカメラ(運転席目線)を切り替えられます。手続き生成した簡易的な車体モデルを両カメラ視点で表示します(外部3Dモデルは使用していません)。1 周完了するとブラウザの開発者コンソールにログが出力されます。

エンジン音・ブレーキ音・コーナーのグリップ限界を超えたときのスクラブ音を再生します(外部音声ファイルは使わず、Web Audio APIで手続き生成)。ブラウザの自動再生制限のため、最初のキー入力(↑/W/↓/S)で音が有効になります。画面左下の「mute」ボタンでミュートできます。

コース外にも手続き生成した簡易的な景観を配置します(外部3Dモデルは使用していません)。モナコはビル群・トンネル区間・港区間(水面とヨット)、鈴鹿は縁石・芝生・樹木と、コースの性格に応じて見た目が変わります。

`npm run build` で `web/dist/` に本番ビルドを出力します。`npm run lint` で ESLint を実行します(`sim/` 配下から `three` を import すると検出されます)。

### コースの切り替え

画面左下の「course」ドロップダウンから、または URL に `?course=<id>` を付けることで読み込むコースを切り替えられます(既定 `monaco`)。

| コース | `id` |
|---|---|
| モナコ | `monaco` |
| 鈴鹿 | `suzuka` |

例: http://localhost:5173/?course=suzuka

## コースデータの再生成

同梱の `web/public/course/monaco.json` / `web/public/course/suzuka.json` は FastF1 の決勝データから生成済みです。再生成する場合:

```bash
cd tools
uv run gradient-circuit generate --circuit monaco --out ../web/public/course/monaco.json
uv run gradient-circuit generate --circuit suzuka --out ../web/public/course/suzuka.json
```

- `--circuit`(既定 `monaco`)でコースを選択します。コースごとの設定(FastF1 のイベント名、受け入れ基準の目標値、道幅クランプ範囲)は `tools/src/gradient_circuit/circuits.py` にまとめてあります。
- セッションは既定で自動選択されます(現在年から遡り、位置データが取得できる最新の決勝)。`--year 2026` のように明示指定も可能です。
- 初回実行時は FastF1 が API からデータを取得するため数分かかります。取得結果は `tools/.fastf1cache/`(Git 管理外)にキャッシュされます。
- 実行後、コースデータが受け入れ基準(全長・標高差・全幅・ループ閉合誤差・曲率の連続性・欠損値なし・サンプル配列長の整合性)を満たすか自動検証し、結果をコンソールに出力します。具体的な目標値はコースごとに異なり(モナコ: 全長3337m±3%・標高差40m±15%・全幅8〜12m、鈴鹿: 全長5807m±3%・標高差40m±15%・全幅10〜16m)、`circuits.py` を参照してください。

### テスト

```bash
cd tools
uv run pytest
```

FastF1 への通信を伴わない、幾何計算(曲率符号・弧長リサンプル・道幅クランプ・受け入れ基準判定)のユニットテストです。

## 別エンジンへの移植について

`web/public/course/*.json`(モナコ・鈴鹿とも)は Three.js に固有の情報を一切含まない、エンジン非依存の中間形式(`gradient-circuit/course@1`)です。座標は Z 上・右手系(Three.js の Y 上への変換は `web/src/course/loader.ts` が担当)。この JSON をそのまま読み込めば、Unity など別エンジンでも同じコースデータを利用できます。

| 再実装が必要 | そのまま流用可 |
|---|---|
| `web/src/render/*`(Three.js 固有の描画) | `web/public/course/*.json`(データそのもの) |
| `web/src/ui/*`(DOM 固有の HUD/操作) | `web/src/sim/track.ts` / `sim/vehicle.ts` のアルゴリズム(純粋な数式のみ、`three` 非依存。ESLint で機械的に強制) |
| `web/src/camera/*Rig`(カメラ API 固有) | `web/src/camera/types.ts` のインタフェース定義 |

## ライセンス

準備中。
