const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** 回傳 HTML；不讓任何頁面被別的網站以 frame 嵌入。 */
export function htmlResponse(body: string, title: string, status = 200): Response {
  const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
fieldset{margin:1rem 0}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;font-size:.9rem;vertical-align:top}
code{word-break:break-all}
</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      // 只允許內嵌樣式；表單只能送回本站，或導向 returnUrl（任意 http(s) 網址，由呼叫端指定）
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http: https:",
      "Cache-Control": "no-store",
    },
  });
}
