import { describe, it, expect } from "vitest";
import { driveButtonView } from "./drive-ui";

describe("driveButtonView", () => {
  it("shows a success-styled 'Connected' button when connected", () => {
    const v = driveButtonView(true);
    expect(v.label).toContain("Connected");
    expect(v.className).toContain("btn-success");
    expect(v.className).toContain("btn");
  });

  it("shows the neutral 'Connect Drive' button when not connected", () => {
    const v = driveButtonView(false);
    expect(v.label).toBe("Connect Drive");
    expect(v.className).toContain("btn-secondary");
    expect(v.className).not.toContain("btn-success");
  });
});
