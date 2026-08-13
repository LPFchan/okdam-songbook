import adapter from "@sveltejs/adapter-static";

const base = process.env.VITE_APP_BASE_PATH?.replace(/\/$/, "") ?? "";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: adapter({ fallback: "index.html", pages: "dist", assets: "dist" }),
    paths: { base }
  }
};

export default config;
