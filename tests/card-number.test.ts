import { describe, expect, it } from "vitest";
import { cardNumber } from "../lib/scout/card-number";

describe("searching by card number", () => {
  it("reads a bare number, #number and 'card number'", () => {
    expect(cardNumber("102")).toBe(102);
    expect(cardNumber(" #102 ")).toBe(102);
    expect(cardNumber("card 102")).toBe(102);
    expect(cardNumber("Card #7")).toBe(7);
  });
  it("leaves tickers, company names and nonsense alone", () => {
    for (const t of ["NVDA", "3M", "102 capital", "0", "#", "", "1.5", "12345678"]) expect(cardNumber(t)).toBeNull();
  });
});
