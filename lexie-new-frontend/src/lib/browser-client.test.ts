import { describe, expect, it, beforeEach } from "vitest";
import {
  BROWSER_CLIENT_STORAGE_KEY,
  getBrowserClientId,
  isValidBrowserClientId,
  resetBrowserClientIdForTests,
} from "./browser-client";

describe("browser client id", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBrowserClientIdForTests();
  });

  it("persists the generated id in localStorage", () => {
    const first = getBrowserClientId();
    const second = getBrowserClientId();

    expect(first).toBe(second);
    expect(localStorage.getItem(BROWSER_CLIENT_STORAGE_KEY)).toBe(first);
    expect(isValidBrowserClientId(first)).toBe(true);
  });
});
