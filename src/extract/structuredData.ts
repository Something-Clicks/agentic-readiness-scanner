import type { CheerioAPI } from "cheerio";

/**
 * A structured-data node lifted out of the page, normalized across the three
 * syntaxes the spec calls for: JSON-LD, microdata, and RDFa.
 */
export interface StructuredNode {
  syntax: "json-ld" | "microdata" | "rdfa";
  types: string[];
  props: Record<string, unknown>;
}

export interface StructuredData {
  nodes: StructuredNode[];
  /** JSON-LD blocks that were present but did not parse. */
  invalidJsonLdBlocks: Array<{ snippet: string; error: string }>;
  jsonLdBlockCount: number;
}

/** schema.org LocalBusiness and the subtypes a local service business is likely to use. */
const LOCAL_BUSINESS_TYPES = new Set(
  [
    "LocalBusiness", "AnimalShelter", "ArchiveOrganization", "AutomotiveBusiness", "AutoBodyShop",
    "AutoDealer", "AutoPartsStore", "AutoRental", "AutoRepair", "AutoWash", "GasStation",
    "MotorcycleDealer", "MotorcycleRepair", "ChildCare", "Dentist", "DryCleaningOrLaundry",
    "EmergencyService", "FireStation", "Hospital", "PoliceStation", "EmploymentAgency",
    "EntertainmentBusiness", "AdultEntertainment", "AmusementPark", "ArtGallery", "Casino",
    "ComedyClub", "MovieTheater", "NightClub", "FinancialService", "AccountingService",
    "AutomatedTeller", "BankOrCreditUnion", "InsuranceAgency", "FoodEstablishment", "Bakery",
    "BarOrPub", "Brewery", "CafeOrCoffeeShop", "Distillery", "FastFoodRestaurant", "IceCreamShop",
    "Restaurant", "Winery", "GovernmentOffice", "PostOffice", "HealthAndBeautyBusiness",
    "BeautySalon", "DaySpa", "HairSalon", "HealthClub", "NailSalon", "TattooParlor", "HomeAndConstructionBusiness",
    "Electrician", "GeneralContractor", "HVACBusiness", "HousePainter", "Locksmith", "MovingCompany",
    "Plumber", "RoofingContractor", "InternetCafe", "LegalService", "Attorney", "Notary", "Library",
    "LodgingBusiness", "BedAndBreakfast", "Campground", "Hostel", "Hotel", "Motel", "Resort",
    "MedicalBusiness", "Physician", "Optician", "Pharmacy", "VeterinaryCare", "ProfessionalService",
    "RadioStation", "RealEstateAgent", "RecyclingCenter", "SelfStorage", "ShoppingCenter",
    "SportsActivityLocation", "BowlingAlley", "ExerciseGym", "GolfCourse", "PublicSwimmingPool",
    "SkiResort", "SportsClub", "StadiumOrArena", "TennisComplex", "Store", "BikeStore", "BookStore",
    "ClothingStore", "ComputerStore", "ConvenienceStore", "DepartmentStore", "ElectronicsStore",
    "Florist", "FurnitureStore", "GardenStore", "GroceryStore", "HardwareStore", "HobbyShop",
    "HomeGoodsStore", "JewelryStore", "LiquorStore", "MensClothingStore", "MobilePhoneStore",
    "MovieRentalStore", "MusicStore", "OfficeEquipmentStore", "OutletStore", "PawnShop", "PetStore",
    "ShoeStore", "SportingGoodsStore", "TireShop", "ToyStore", "WholesaleStore", "TelevisionStation",
    "TouristInformationCenter", "TravelAgency", "Cemetery", "Crematorium", "FuneralHome",
  ].map((t) => t.toLowerCase()),
);

export function isLocalBusinessType(type: string): boolean {
  return LOCAL_BUSINESS_TYPES.has(stripSchemaPrefix(type).toLowerCase());
}

export function stripSchemaPrefix(type: string): string {
  return type.replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "").trim();
}

export function extractStructuredData($: CheerioAPI): StructuredData {
  const nodes: StructuredNode[] = [];
  const invalidJsonLdBlocks: Array<{ snippet: string; error: string }> = [];

  const jsonLdBlocks = $('script[type="application/ld+json"]').toArray();
  for (const element of jsonLdBlocks) {
    const raw = $(element).text().trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
      for (const node of flattenJsonLd(parsed)) nodes.push(node);
    } catch (error) {
      invalidJsonLdBlocks.push({
        snippet: raw.slice(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  nodes.push(...extractMicrodata($));
  nodes.push(...extractRdfa($));

  return { nodes, invalidJsonLdBlocks, jsonLdBlockCount: jsonLdBlocks.length };
}

/** Some CMS plugins emit JSON-LD wrapped in CDATA or HTML comments. */
function stripJsonComments(raw: string): string {
  return raw
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/^\s*\/\/\s*<!\[CDATA\[/, "")
    .replace(/\/\/\s*\]\]>\s*$/, "")
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .trim();
}

/** Walk @graph, arrays, and nested objects so a node anywhere in the tree is found. */
function flattenJsonLd(value: unknown, depth = 0): StructuredNode[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenJsonLd(item, depth + 1));

  const object = value as Record<string, unknown>;
  const out: StructuredNode[] = [];

  if ("@graph" in object) {
    out.push(...flattenJsonLd(object["@graph"], depth + 1));
  }

  const types = toArray(object["@type"]).map((t) => stripSchemaPrefix(String(t)));
  if (types.length > 0) {
    out.push({ syntax: "json-ld", types, props: object });
  }

  for (const [key, nested] of Object.entries(object)) {
    if (key === "@graph" || key === "@type" || key === "@context") continue;
    if (nested !== null && typeof nested === "object") {
      out.push(...flattenJsonLd(nested, depth + 1));
    }
  }
  return out;
}

function extractMicrodata($: CheerioAPI): StructuredNode[] {
  return $("[itemscope][itemtype]")
    .toArray()
    .map((element) => {
      const node = $(element);
      const types = String(node.attr("itemtype") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map(stripSchemaPrefix);
      const props: Record<string, unknown> = {};

      node.find("[itemprop]").each((_, propEl) => {
        const prop = $(propEl);
        // Skip props belonging to a nested itemscope — those are that node's, not ours.
        if (prop.parents("[itemscope]").first().get(0) !== element) return;
        const name = String(prop.attr("itemprop") ?? "").trim();
        if (!name) return;
        const value =
          prop.attr("content") ??
          prop.attr("datetime") ??
          prop.attr("href") ??
          prop.attr("src") ??
          prop.text().trim();
        appendProp(props, name, value);
      });

      return { syntax: "microdata" as const, types, props };
    })
    .filter((node) => node.types.length > 0);
}

function extractRdfa($: CheerioAPI): StructuredNode[] {
  return $("[typeof]")
    .toArray()
    .map((element) => {
      const node = $(element);
      const types = String(node.attr("typeof") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map(stripSchemaPrefix);
      const props: Record<string, unknown> = {};

      node.find("[property]").each((_, propEl) => {
        const prop = $(propEl);
        if (prop.parents("[typeof]").first().get(0) !== element) return;
        const name = stripSchemaPrefix(String(prop.attr("property") ?? "")).trim();
        if (!name) return;
        const value = prop.attr("content") ?? prop.attr("href") ?? prop.text().trim();
        appendProp(props, name, value);
      });

      return { syntax: "rdfa" as const, types, props };
    })
    .filter((node) => node.types.length > 0);
}

function appendProp(props: Record<string, unknown>, name: string, value: unknown): void {
  const existing = props[name];
  if (existing === undefined) {
    props[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    props[name] = [existing, value];
  }
}

export function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull a readable string out of a schema.org value that may be a string, object, or array. */
export function textValue(value: unknown): string | null {
  for (const item of toArray(value)) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "number") return String(item);
    if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>;
      const nested = object["name"] ?? object["@value"] ?? object["value"] ?? object["url"];
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return null;
}

export function findNodes(data: StructuredData, predicate: (type: string) => boolean): StructuredNode[] {
  return data.nodes.filter((node) => node.types.some(predicate));
}

export function findLocalBusinessNodes(data: StructuredData): StructuredNode[] {
  return findNodes(data, isLocalBusinessType);
}

/** Organization is a weaker signal than LocalBusiness but still machine-readable. */
export function findOrganizationNodes(data: StructuredData): StructuredNode[] {
  return findNodes(data, (type) => {
    const t = stripSchemaPrefix(type).toLowerCase();
    return t === "organization" || t === "corporation" || t === "ngo";
  });
}
