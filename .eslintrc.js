module.exports = {
    ignorePatterns: ["test/*.js", "server/modules/*"],
    root: true,
    env: {
        commonjs: true,
        es2022: true,
        node: true,
    },
    extends: [
        "eslint:recommended",
        "plugin:jsdoc/recommended-error",
        "prettier", // Disables ESLint formatting rules that conflict with Prettier
    ],
    parserOptions: {
        sourceType: "module",
        ecmaVersion: 2022,
    },
    plugins: ["jsdoc", "@typescript-eslint"],
    rules: {
        yoda: "error",
        eqeqeq: ["warn", "smart"],
        camelcase: [
            "warn",
            {
                properties: "never",
                ignoreImports: true,
            },
        ],
        "no-unused-vars": [
            "warn",
            {
                args: "none",
            },
        ],
        curly: "error",
        "no-var": "error",
        "no-throw-literal": "error",
        "no-constant-condition": [
            "error",
            {
                checkLoops: false,
            },
        ],
        //"no-console": "warn",
        "no-extra-boolean-cast": "off",
        "no-unneeded-ternary": "error",
        //"prefer-template": "error",
        "no-empty": [
            "error",
            {
                allowEmptyCatch: true,
            },
        ],
        "no-control-regex": "off",
        "one-var": ["error", "never"],
        "max-statements-per-line": ["error", { max: 1 }],
        "jsdoc/check-tag-names": [
            "error",
            {
                definedTags: ["link"],
            },
        ],
        "jsdoc/no-undefined-types": "off",
        "jsdoc/no-defaults": ["error", { noOptionalParamNames: true }],
        "jsdoc/require-throws": "warn",
        "jsdoc/require-jsdoc": [
            "error",
            {
                require: {
                    FunctionDeclaration: true,
                    MethodDefinition: true,
                },
            },
        ],
        "jsdoc/no-blank-block-descriptions": "error",
        "jsdoc/require-returns-description": "warn",
        "jsdoc/require-returns-check": ["error", { reportMissingReturnForUndefinedTypes: false }],
        "jsdoc/require-returns": [
            "warn",
            {
                forceRequireReturn: true,
                forceReturnsWithAsync: true,
            },
        ],
        "jsdoc/require-param-type": "warn",
        "jsdoc/require-param-description": "warn",
    },
    overrides: [
        // Override for TypeScript
        {
            files: ["**/*.ts"],
            extends: ["plugin:@typescript-eslint/recommended"],
            rules: {
                "jsdoc/require-returns-type": "off",
                "jsdoc/require-returns": [
                    "warn",
                    {
                        forceRequireReturn: false,
                        forceReturnsWithAsync: false,
                    },
                ],
                "jsdoc/require-param-type": "off",
                "@typescript-eslint/no-explicit-any": "off",
                "@typescript-eslint/ban-ts-comment": "off",
                "prefer-const": "off",
                "@typescript-eslint/no-unused-vars": "warn",
                eqeqeq: "off",
            },
        },
    ],
};
