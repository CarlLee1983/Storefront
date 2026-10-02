# Design System: Storefront (靜物)

> **核心定位**：溫潤人文選物風（Warm Minimalist & Editorial），融合現代北歐家具雜誌（如 Kinfolk、HAY、Zara Home、Karimoku）的優雅留白與現代俐落排版，搭配簡約低調的 SaaS 後台管理體驗。

---

## 1. Visual Theme & Atmosphere (視覺氛圍與美學調性)

- **風格定位**：溫潤、雅緻、留白充足的人文生活器物電商與清晰俐落的 SaaS 營運後台。
- **Density (資訊密度)**：
  - **前台商城 (Storefront)**：`Density: 4 (Daily App Balanced / Editorial Airy)`。充足的呼吸感、適度留白，著重展示器物材質與線條美感。
  - **後台管理 (Admin)**：`Density: 6 (Modern SaaS Balanced)`。卡片化分區（Carded sections）、清楚的欄位層次與直覺的表單元件，避免擁擠或玩具感。
- **Variance (結構動態感)**：`Variance: 6 (Offset Asymmetric & Structured Editorial)`。打破千篇一律的對稱 3 等分卡片，以高低起伏的圖文不對稱、畫報風排版與水平橫向軌道呈現。
- **Motion (動態質感)**：`Motion: 5 (Fluid & Tactile)`。採用物理彈簧手感（Spring Physics），微幅微動態（Micro-interactions）與細膩的 Hover Lift，嚴禁過度炫技與誇張晃動。

---

## 2. Color Palette & Roles (色彩校準與語意角色)

全站採用單一溫潤亞麻基調，徹底杜絕冷硬的純白/死黑與刺眼的霓虹紫色光暈。

| 色彩名稱 | 色值 (Hex / RGBA) | 語意與角色功能 |
| :--- | :--- | :--- |
| **Warm Canvas (畫布底色)** | `#fcfbf9` | 全站主要背景，溫潤細膩的亞麻暖白紙質底色 |
| **Pure Surface (卡片與表層)** | `#ffffff` | 卡片容器、對話框、選單面板，提供純淨的前景層次 |
| **Warm Panel (次級面板)** | `#f5f4ef` | 英雄橫幅背景、微型工具列、圖片底色 |
| **Translucent Panel** | `rgba(245, 244, 239, 0.85)` | 模糊磨砂毛玻璃覆蓋層、吸頂導航列（Header blur） |
| **Terracotta Red (主強調色)** | `#9e3d2c` | 單一主強調色：CTA 購買按鈕、活動標籤、焦點聚焦、頁碼指引 |
| **Terracotta Deep (強調懸停)** | `#822e1f` | 按鈕 Hover 狀態、文字連結 Hover 狀態 |
| **Terracotta Light (強調淡底)** | `#fbeee9` | 促銷標籤背景、輕量 Badge、選中背景 |
| **Charcoal Ink (文字墨黑)** | `#1a1918` | 主要標題、高對比內文，非死黑的石墨暖黑 |
| **Warm Charcoal (反色主體)** | `#1c1b1a` | 反色按鈕、深色 Floating Pill Toast、主視覺重點 |
| **Muted Earth (次要灰調)** | `#6e6b66` | 輔助文字、價格未折扣線、副標題、次級導航 |
| **Subtle Sand (弱化灰調)** | `#9c978f` | 圖示淡色、佔位符號、未啟用狀態 |
| **Sandstone Border (結構邊線)** | `#e6e3da` | 卡片 1px 極細邊框、隔線、輸入框預設邊框 |
| **Control Border (控制線條)** | `#999388` | 可聚焦控制項邊線、步進器邊框 |
| **Warm Error (溫潤警示紅)** | `#9e2a2b` | 錯誤表單警示、庫存告急標記 |

---

## 3. Typography Architecture (字體架構與排版規範)

- **字體家族**：
  - **內文與介面 (Body & UI)**：`"Inter", -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", system-ui, sans-serif`（英文採自行託管 Inter Latin 400/700/800，中文字型流暢回退蘋方與思源黑體）。
  - **選物標題與畫報裝飾 (Display / Serif)**：`"Georgia", "Songti TC", "Source Han Serif TC", serif`（在編輯式 Banner 與引言處營造典雅人文感）。
- **階層與數值規範**：
  - **Display Hero**：`clamp(2.25rem, 5vw, 3.5rem)`，`line-height: 1.15`，`letter-spacing: -0.02em`，字重 700/800，啟動 `text-wrap: balance`。
  - **H1 (Page Title)**：`1.75rem (28px)`，`font-weight: 700`，`letter-spacing: -0.025em`。
  - **H2 (Section Title)**：`1.25rem (20px)`，`font-weight: 600`，`letter-spacing: -0.015em`。
  - **Body Base**：`1rem (16px)`，`line-height: 1.65`，單行行長限制在 `65ch` 以內以維持最佳閱讀節奏。
  - **Body Small / Meta**：`0.875rem (14px)`，`line-height: 1.5`。
  - **Micro Label**：`0.75rem (12px)`，`font-weight: 600`，字距 `0.05em`。
- **超連結排版規範 (Links)**：
  - 杜絕刺眼的整條粗下劃線或無提示的死板跳轉。
  - 採用 Editorial Micro-Underline：陶土紅搭配 35% 不透明度的柔和細下劃線（`text-decoration-color: rgba(158, 61, 44, 0.35)`），位移 `0.25em`。
  - Hover 時文字與底線平滑過渡加深為 `#822e1f`，底線微幅增至 `1.5px`。

---

## 4. Component Stylings & Interaction (元件設計與互動手感)

### 4.1 Buttons & CTA (按鈕系統)
- **Primary Button**：
  - 陶土紅背景 `#9e3d2c`，白色文字 `#faf9f6`。
  - 圓角：`var(--radius-sm) (6px)`。
  - 陰影：微細實體陰影 `0 1px 3px rgba(158, 61, 44, 0.2)`。
  - 互動：Hover 時上浮 1px 並加深陰影；Active 點擊時下壓（`translateY(0)` 或 `scale(0.98)`）。
- **Secondary / Ghost Button**：
  - 面板底色 `#ffffff` 或透明，1px 邊框 `#e6e3da`，Hover 時背景微暖 `#f5f4ef`。
- **Hero Capsule Controls (首頁導航膠囊)**：
  - 嚴格禁止粗糙的浮動圓球。
  - 採用低調一體式的 Ghost Controls Capsule：左側等寬現代數字編號（`01 / 03`），中間極細陶土紅進度條，右側緊湊型線條微按鈕（Ghost Nav Buttons）。

### 4.2 Cards & Containers (卡片與容器)
- **商品卡片 (Product Cards)**：
  - 白色背景 `#ffffff`，1px 暖邊框 `#e6e3da`，圓角 8px (`var(--radius-md)`)。
  - 陰影：預設為極致漫射的柔和層次 `0 4px 20px -2px rgba(28, 27, 26, 0.06)`。
  - Hover 效果：輕盈上浮 3px（`translateY(-3px)`），圖片以 `1.04` 比例微幅平滑縮放。
- **標籤 (Pill Badges)**：
  - 促銷折扣標籤使用膠囊造型（`radius-full`），陶土淡底 `#fbeee9` 搭配深陶土字 `#9e3d2c`。

### 4.3 Form Controls & Inputs (表單與輸入框)
- **輸入框與選單 (Inputs & Selects)**：
  - 最小觸控高度 `44px`（符合無障礙標準）。
  - 背景純白，邊線 `#e6e3da`，圓角 6px。
  - Focus 狀態：深黑/陶土焦黑雙層焦點圈（`outline: 2px solid #1c1b1a; outline-offset: 2px;`），絕不使用瀏覽器預設亮藍框。
- **數量步進器 (Quantity Stepper)**：
  - 整合式單一圓角邊框容器，內部按鈕無縫相接，等寬數字居中。

### 4.4 Feedback & Overlays (回饋與浮層)
- **購物車通知 (Cart Toast)**：
  - 底部懸浮深曜石色膠囊（`background: #1c1b1a`，文字 `#faf9f6`），搭配彈簧動畫自底部滑入。
- **搜尋對話框 (Search Modal)**：
  - 80% 磨砂毛玻璃遮罩（`backdrop-filter: blur(8px)`），中央浮層卡片，自動聚焦搜尋欄。

---

## 5. Layout & Responsive Principles (版面與響應式哲學)

1. **Max-Width 限制**：
   - 前台主要內容區：`width: min(100%, 72rem)`（約 1152px），居中配置。
   - 後台管理工作區：`width: min(100%, 90rem)`（約 1440px），確保表格能舒適橫向展開。
2. **網格非對稱性 (Asymmetric Layouts)**：
   - 首頁主視覺採左側文案、右側大圖的非對稱比例分割（桌機 `2fr : 3fr`）。
   - 分類磚（Category Tiles）採用非等寬展示，大圖與小圖形成視線高低流動。
3. **行動裝置體驗 (< 768px)**：
   - 嚴格保證無任何未預期的水平橫向捲動（Horizontal Overflow Ban）。
   - 輪播與橫幅在小螢幕自動轉為垂直自然堆疊（圖片在上、標題與按鈕在下）。
   - 所有點擊目標嚴格滿足 `44px x 44px` 最小觸控標準。

---

## 6. Motion Philosophy (動態與轉場哲學)

- **Spring Curve**：`cubic-bezier(0.16, 1, 0.3, 1)`（具備高級阻尼感，快速啟動、柔和到位）。
- **Smooth Transition**：`cubic-bezier(0.4, 0, 0.2, 1)`（用於顏色與透明度漸變）。
- **Duration 刻度**：
  - 微按鈕/狀態變化：`150ms` (`--duration-fast`)
  - 抽屜/卡片浮動/對話框：`250ms` (`--duration-normal`)
- **硬體加速保證**：
  - 嚴格僅對 `transform` 和 `opacity` 進行過渡動畫，絕不對 `top`, `left`, `width`, `height` 做動態補間。
- **Prefers-reduced-motion**：
  - 支援系統無障礙減少動態模式，自動關閉自動輪播並簡化位移動畫。

---

## 7. Anti-Patterns (明確禁止的設計反模式)

- ❌ **絕對禁止粗暴的純黑與純灰冷調**：禁止 `#000000` 與冰冷的藍灰（如 `#f1f5f9`），全站基底必須維持溫潤大地色系。
- ❌ **絕對禁止霓虹發光或紫色光暈 (AI Neon Cliché Ban)**：按鈕與卡片嚴禁使用紫色/青色霓虹 Glow 陰影。
- ❌ **絕對禁止突兀笨拙的巨大浮動圓球按鈕**：控制列應優雅融入版面或膠囊化。
- ❌ **絕對禁止無意識的 3 等分無趣卡片排列**：必須運用非對稱尺度、留白與雜誌畫報節奏。
- ❌ **絕對禁止廉價 emoji 作為主要圖示**：介面圖示均使用乾淨細緻的 SVG 向量圖標（線寬 1.5px ~ 1.75px）。
- ❌ **絕對禁止覆蓋文字無襯底導致對比不足**：文字不可隨意直接覆蓋在色彩複雜的圖片上方。
