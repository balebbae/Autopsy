// Cloudflare Pages Function for the root path.
//
// User-Agent sniffing so the same URL (install.autopsy.surf) serves:
//   - browsers / crawlers   → static landing page (index.html)
//   - curl / wget / httpie  → install.sh body, ready to pipe to bash
//
// This matches the convention set by sh.rustup.rs, get.docker.com, etc.

const PIPEABLE_UA =
  /^(curl|wget|fetch|httpie|powershell|GoogleHC|wapack)/i

export async function onRequest(context) {
  const ua = context.request.headers.get("user-agent") || ""

  if (PIPEABLE_UA.test(ua)) {
    const url = new URL("/install.sh", context.request.url)
    const res = await context.env.ASSETS.fetch(url)
    // Re-emit with the right content-type so the shell doesn't choke.
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "public, max-age=300, must-revalidate",
      },
    })
  }

  return context.next()
}
