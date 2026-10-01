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
}

const heroImage = (n: number, alt: string): HomeImage => ({ name: `hero-${n}`, widths: [640, 1024, 1600], width: 1600, height: 914, alt });

export const HERO_SLIDES: HeroSlide[] = [
  {
    image: heroImage(1, "陽光灑落的客廳，胡桃木單椅與黑色石材邊几"),
    title: "為日常挑一張好椅子",
    description: "胡桃木與織布面的單椅、邊几，讓客廳慢下來。",
  },
  {
    image: heroImage(2, "餐廳裡的橡木圓桌、編繩餐椅與黑色吊燈"),
    title: "把餐桌留給好好吃飯的時刻",
    description: "橡木圓桌、編繩餐椅與一盞低垂的燈。",
  },
  {
    image: heroImage(3, "工作桌上的朱紅檯燈、書堆與花器"),
    title: "工作桌上也值得有一點顏色",
    description: "原木桌面、朱紅檯燈與安靜的書堆。",
  },
];

export const EDITORIAL_BANNER = {
  image: { name: "banner", widths: [480, 800, 1122], width: 1122, height: 1402, alt: "橡木桌上的陶罐與橄欖枝" } satisfies HomeImage,
  title: "選一件，用很久",
  description: "每一件都經過挑選，只留下耐看、耐用，值得放進家裡的選物。",
  linkText: "逛逛全部商品",
};

export function imageSrcset({ name, widths }: Pick<HomeImage, "name" | "widths">): string {
  return widths.map((w) => `/home/${name}-${w}.webp ${w}w`).join(", ");
}

/** 不支援 srcset 時的退路：取中間寬度。 */
export function imageSrc({ name, widths }: Pick<HomeImage, "name" | "widths">): string {
  return `/home/${name}-${widths[1] ?? widths[0]}.webp`;
}
