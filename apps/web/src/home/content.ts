/** 首頁主視覺與編輯式橫幅的內容：文案與圖片都寫在程式碼裡，隨部署發佈（圖片由 scripts/home-images.sh 產生）。 */

export interface HomeImage {
  /** 檔名前綴；實際檔案為 `/home/{name}-{寬度}.webp`。 */
  name: string;
  widths: number[];
  /** 最大寬度版本的尺寸，宣告在 `<img>` 上讓瀏覽器預留版面。 */
  width: number;
  height: number;
  alt: string;
}

export interface HeroSlide {
  image: HomeImage;
  title: string;
  description: string;
  href: string;
  linkText: string;
}

const heroImage = (n: number, alt: string): HomeImage => ({ name: `hero-${n}`, widths: [640, 1024, 1600], width: 1600, height: 914, alt });

export const HERO_SLIDES: HeroSlide[] = [
  {
    image: heroImage(1, "日光照進客廳，胡桃木單椅擺在右側。"),
    title: "留一個位置給自己",
    description: "一張單椅與留白的牆面，讓客廳也有慢下來的角落。",
    href: "/categories/living",
    linkText: "逛客廳選物",
  },
  {
    image: heroImage(2, "餐廳中的圓桌、餐椅與吊燈。"),
    title: "把時間留在餐桌上",
    description: "從餐桌、座椅到器皿，讓每日的相聚多一點從容。",
    href: "/categories/dining",
    linkText: "逛餐廳選物",
  },
  {
    image: heroImage(3, "木書桌上有朱紅色檯燈與書本，左側是留白的牆面。"),
    title: "整理出專注的角落",
    description: "一張桌、一盞燈，替每天的想法留出空間。",
    href: "/categories/workspace",
    linkText: "逛工作區選物",
  },
];

export const EDITORIAL_BANNER = {
  image: { name: "banner", widths: [480, 800, 1122], width: 1122, height: 1402, alt: "橡木桌上的陶罐與橄欖枝" } satisfies HomeImage,
  title: "日常，從喜歡的物件開始",
  description: "一盞燈、一只器皿，從每天會碰觸的地方慢慢挑起。",
  linkText: "全部商品",
};

export function imageSrcset({ name, widths }: Pick<HomeImage, "name" | "widths">): string {
  return widths.map((w) => `/home/${name}-${w}.webp ${w}w`).join(", ");
}

/** 不支援 srcset 時的退路：取中間寬度。 */
export function imageSrc({ name, widths }: Pick<HomeImage, "name" | "widths">): string {
  return `/home/${name}-${widths[1] ?? widths[0]}.webp`;
}
