import { describe, expect, test } from "bun:test";
import { STACK_RECIPES, stackRecipe } from "../src/recipes.ts";

describe("curated stack recipes", () => {
    test("have unique ids and resolve only known ids", () => {
        const ids = STACK_RECIPES.map((recipe) => recipe.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const recipe of STACK_RECIPES) expect(stackRecipe(recipe.id)).toBe(recipe);
        expect(stackRecipe("unknown")).toBeNull();
        expect(stackRecipe("")).toBeNull();
        expect(stackRecipe(null)).toBeNull();
    });

    test("the LibreDB recipe pins one release by digest and requires its secrets", () => {
        const recipe = stackRecipe("libredb");
        expect(recipe).not.toBeNull();
        if (!recipe) return;
        const compose = Bun.YAML.parse(recipe.compose) as {
            services?: Record<
                string,
                { image?: string; stop_grace_period?: string; ports?: string[]; environment?: Record<string, unknown> }
            >;
        };
        const studio = compose.services?.studio;
        expect(studio?.image).toBe(
            "ghcr.io/libredb/libredb-studio:1.3.0@sha256:3521f28fc2732a040715015669dfb475a1f2bc60b31025cb58ef472379ca74c7",
        );
        expect(studio?.stop_grace_period).toBe("30s");
        expect(studio?.ports).toEqual(["127.0.0.1:3001:3000"]);
        expect(studio?.environment?.AUTH_BOOTSTRAP).toBe("off");
        expect(studio?.environment?.STORAGE_PROVIDER).toBe("sqlite");
        expect(recipe.compose).toContain("${ADMIN_PASSWORD:?");
        expect(recipe.compose).toContain("${JWT_SECRET:?");
        expect(recipe.env).toContain("ADMIN_PASSWORD=\n");
        expect(recipe.env).toContain("JWT_SECRET=\n");
    });
});
