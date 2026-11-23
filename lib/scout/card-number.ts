/** Pure: the card number someone typed into a search box ("102", "#102", "card 102"), or null when it is not one. */
export function cardNumber(typed: string): number | null {
  const m = /^(?:card\s*)?#?\s*(\d{1,7})$/i.exec(typed.trim());
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}
