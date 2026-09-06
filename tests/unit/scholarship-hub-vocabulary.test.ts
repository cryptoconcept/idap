import { describe, it, expect } from "vitest";
import fixture from "../fixtures/hub-vocabulary.json";
import * as V from "@/lib/scholarship-hub/vocabulary";

describe("vendored Hub vocabulary", () => {
  it("matches the shared contract snapshot exactly", () => {
    expect([...V.HUB_SCHOLARSHIP_CATEGORIES]).toEqual(fixture.scholarshipCategories);
    expect([...V.HUB_EDUCATION_LEVELS]).toEqual(fixture.educationLevels);
    expect([...V.HUB_GENDERS]).toEqual(fixture.genders);
    expect([...V.HUB_COMMUNITY_CATEGORIES]).toEqual(fixture.communityCategories);
    expect([...V.HUB_QUESTION_TYPES]).toEqual(fixture.questionTypes);
    expect([...V.HUB_APPLICATION_MODES]).toEqual(fixture.applicationModes);
    expect([...V.HUB_STATE_CODES]).toEqual(fixture.stateCodes);
    expect([...V.HUB_KA_DISTRICT_CODES]).toEqual(fixture.kaDistrictCodes);
  });
});
