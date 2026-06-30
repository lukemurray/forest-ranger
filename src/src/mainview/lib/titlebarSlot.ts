import { createContext, useContext } from "react";

/**
 * DOM node for the full-width titlebar row in the layout. Views render their
 * own <Titlebar>, which portals into this slot so the title always spans the
 * top — above the main content and the side dock alike.
 */
export const TitlebarSlotContext = createContext<HTMLElement | null>(null);

export function useTitlebarSlot(): HTMLElement | null {
	return useContext(TitlebarSlotContext);
}
