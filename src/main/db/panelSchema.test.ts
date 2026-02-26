import { PANEL_SCHEMA_VERSION, PANEL_QUERIES } from "./panelSchema.js";

describe("panelSchema exports", () => {
  it("PANEL_SCHEMA_VERSION is 2", () => {
    expect(PANEL_SCHEMA_VERSION).toBe(2);
  });

  it("PANEL_QUERIES has expected keys", () => {
    const expectedKeys = [
      "ANCESTORS",
      "SIBLINGS",
      "CHILDREN",
      "ROOT_PANELS",
      "SEARCH",
      "GET_PANEL",
      "MAX_SIBLING_POSITION",
      "PANEL_COUNT",
      "SHIFT_SIBLING_POSITIONS",
      "UPDATE_POSITION_AND_PARENT",
      "CHILDREN_PAGINATED",
      "CHILDREN_COUNT",
      "ROOT_PANELS_PAGINATED",
      "ROOT_PANELS_COUNT",
      "ARCHIVE_PANEL",
    ];
    for (const key of expectedKeys) {
      expect(PANEL_QUERIES).toHaveProperty(key);
    }
  });

  it("PANEL_QUERIES values are non-empty SQL strings", () => {
    for (const [key, value] of Object.entries(PANEL_QUERIES)) {
      expect(typeof value).toBe("string");
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('PANEL_QUERIES.GET_PANEL contains "SELECT * FROM panels"', () => {
    expect(PANEL_QUERIES.GET_PANEL).toContain("SELECT * FROM panels");
  });
});
