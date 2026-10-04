import type { NextConfig } from "next";

const config: NextConfig = {
    reactStrictMode: true,

    // The shared package ships TypeScript source; let Next compile it rather
    // than requiring a separate build step for every consumer.
    transpilePackages: [ "@flatline/shared" ],

    output: "standalone",

    // The repository root .eslintrc.js is Vue-oriented and misfires on TSX
    // (jsdoc/require-jsdoc, no-undef on React). This app is typechecked with
    // `npm run typecheck` instead of inheriting that config.
    eslint: {
        ignoreDuringBuilds: true,
    },
};

export default config;
