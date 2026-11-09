import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

async function reader(anchor: { left: number; top: number; bottom: number }, box: { width: number; height: number }) {
    const events: Record<string, (event: { newState: string }) => void> = {};
    const documentEvents: Record<string, () => void> = {};
    const windowEvents: Record<string, () => void> = {};
    let open = false;
    const tip = {
        style: {} as Record<string, string>,
        parentElement: { querySelector: () => ({ getBoundingClientRect: () => anchor }) },
        getBoundingClientRect: () => box,
        addEventListener: (name: string, handler: (event: { newState: string }) => void) => {
            events[name] = handler;
        },
    };
    runInNewContext(await Bun.file(new URL("../public/app.js", import.meta.url)).text(), {
        window: {
            addEventListener: (name: string, handler: () => void) => {
                windowEvents[name] = handler;
            },
        },
        document: {
            documentElement: { getAttribute: () => null, clientWidth: 320, clientHeight: 480 },
            querySelector: () => null,
            querySelectorAll: (selector: string) =>
                selector === ".info-body[popover]" || (selector === ".info-body:popover-open" && open) ? [tip] : [],
            getElementById: () => null,
            addEventListener: (name: string, handler: () => void) => {
                documentEvents[name] = handler;
            },
        },
    });
    documentEvents.DOMContentLoaded!();
    return {
        tip,
        documentEvents,
        windowEvents,
        toggle: (newState: string) => {
            open = newState === "open";
            events.toggle!({ newState });
        },
    };
}

test("info popovers fit the viewport and flip above a button near the bottom", async () => {
    const view = await reader({ left: 300, top: 440, bottom: 460 }, { width: 240, height: 120 });
    view.toggle("open");
    expect(view.tip.style.left).toBe("72px");
    expect(view.tip.style.top).toBe("312px");
    expect(view.tip.style.margin).toBe("0");
    expect(view.tip.style.inset).toBe("auto");
});

test("info popovers follow the anchor on scrolling and resizing, only while open", async () => {
    const anchor = { left: 12, top: 10, bottom: 30 };
    const view = await reader(anchor, { width: 240, height: 120 });
    view.toggle("open");
    expect(view.tip.style.top).toBe("38px");
    anchor.top = 100;
    anchor.bottom = 120;
    view.documentEvents.scroll!();
    expect(view.tip.style.top).toBe("128px");
    anchor.left = 200;
    view.windowEvents.resize!();
    expect(view.tip.style.left).toBe("72px");
    view.toggle("closed");
    anchor.left = 0;
    view.documentEvents.scroll!();
    expect(view.tip.style.left).toBe("72px");
});

test("oversized info popovers keep their top edge within the viewport", async () => {
    const view = await reader({ left: -20, top: 10, bottom: 30 }, { width: 304, height: 464 });
    view.toggle("open");
    expect(view.tip.style.left).toBe("8px");
    expect(view.tip.style.top).toBe("8px");
});
