/** Chat text helpers shared by the server and the browser (no server imports here). */

/** Where the card's details start in a question asked from a card (the chat shows only the part before it). */
export const CARD_ATTACHED = "\n\n--- the card as logged ---\n";
/** Where other attached details start (a rumor, a news item): hidden in the chat the same way. */
export const ATTACHED = "\n\n--- attached details ---\n";

/** Pure: what the chat shows for a user message (a question without the details attached to it). */
export const shownUserText = (content: string) => content.split(CARD_ATTACHED)[0].split(ATTACHED)[0];
