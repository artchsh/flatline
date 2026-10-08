/** @type {import("next").NextConfig} */
const config = {
    reactStrictMode: true,

    // The shared package ships TypeScript source; let Next compile it rather
    // than requiring a separate build step for every consumer.
    transpilePackages: [ "@flatline/shared" ],

    // This app is typechecked with `npm run typecheck` instead of linting
    // during builds.
    eslint: {
        ignoreDuringBuilds: true,
    },
};

export default config;
