require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  systemInstruction: `
You are EbookPc AI Helper.

You help users with computers, phones, Wi-Fi,
routers, printers, Smart TVs, and online safety.

Give simple, friendly, step-by-step instructions.
Use easy English that older users can understand.

For scam-related questions:
- Warn users not to share OTPs or passwords.
- Never ask users to share sensitive information.
- Explain safe next steps clearly.
- If money has already been sent to a scammer,
  advise contacting their bank immediately.

If you are unsure, say so honestly.
`
});

/* -------------------------------------------------------
   Helper: fetch JSON safely
------------------------------------------------------- */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(
      `Expected JSON but received ${contentType || "unknown content type"}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("The external service returned invalid JSON.");
  }
}

/* -------------------------------------------------------
   Helper: distance between two coordinates
------------------------------------------------------- */

function distanceMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.7613;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMiles * c;
}

/* -------------------------------------------------------
   Helper: find coordinates for a US ZIP + area
------------------------------------------------------- */

async function geocodeUSLocation(area, zipCode) {
  const query = `${area}, ${zipCode}, USA`;

  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
      countrycodes: "us"
    }).toString();

  const data = await fetchJson(url, {
    headers: {
      "User-Agent": "EbookPc/1.0 (EbookPc safety resources)"
    }
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Location could not be found.");
  }

  const latitude = Number(data[0].lat);
  const longitude = Number(data[0].lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Location coordinates are invalid.");
  }

  return { latitude, longitude };
}

/* -------------------------------------------------------
   Helper: query a public Overpass instance
------------------------------------------------------- */

async function getPoliceFromOverpass(endpoint, latitude, longitude) {
  const overpassQuery = `
[out:json][timeout:25];
(
  nwr["amenity"="police"](around:25000,${latitude},${longitude});
  nwr["office"="government"]["government"="police"](around:25000,${latitude},${longitude});
);
out center tags;
`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "EbookPc/1.0 (EbookPc safety resources)"
    },
    body: `data=${encodeURIComponent(overpassQuery)}`
  });

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Police data service returned HTTP ${response.status}`
    );
  }

  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(
      `Police data service returned ${contentType || "non-JSON"}`
    );
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Police data service returned invalid JSON.");
  }

  return data.elements || [];
}

/* -------------------------------------------------------
   HOME
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    message: "EbookPc AI Backend is running!"
  });
});

/* -------------------------------------------------------
   AI HELPER
   Existing functionality — kept unchanged
------------------------------------------------------- */

app.post("/api/ai-helper", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Please provide a valid message."
      });
    }

    const result = await model.generateContent(message);
    const response = await result.response;
    const answer = response.text();

    res.json({ answer });
  } catch (error) {
    console.error("Gemini error:", error.message);

    res.status(500).json({
      error: "AI Helper could not respond right now."
    });
  }
});

/* -------------------------------------------------------
   FIND LOCAL POLICE
   Area + ZIP -> coordinates -> nearest mapped police resource
------------------------------------------------------- */

app.post("/api/police-lookup", async (req, res) => {
  try {
    const { area, zipCode } = req.body;

    if (!area || typeof area !== "string") {
      return res.status(400).json({
        error: "Please provide your area."
      });
    }

    if (!zipCode || !/^\d{5}$/.test(String(zipCode))) {
      return res.status(400).json({
        error: "Please provide a valid 5-digit US ZIP code."
      });
    }

    const { latitude, longitude } = await geocodeUSLocation(
      area.trim(),
      String(zipCode)
    );

    const endpoints = [
      "https://overpass.private.coffee/api/interpreter",
      "https://overpass-api.de/api/interpreter"
    ];

    let elements = [];
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        elements = await getPoliceFromOverpass(
          endpoint,
          latitude,
          longitude
        );

        if (elements.length > 0) {
          break;
        }
      } catch (error) {
        lastError = error;

        console.error(
          `Police provider failed (${endpoint}):`,
          error.message
        );
      }
    }

    if (elements.length === 0 && lastError) {
      throw lastError;
    }

    const policePlaces = elements
      .map((place) => {
        const lat = Number(place.lat ?? place.center?.lat);
        const lon = Number(place.lon ?? place.center?.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return null;
        }

        const tags = place.tags || {};

        const distance = distanceMiles(
          latitude,
          longitude,
          lat,
          lon
        );

        const street = tags["addr:street"];
        const houseNumber = tags["addr:housenumber"];

        const city =
          tags["addr:city"] ||
          tags["addr:town"] ||
          tags["addr:village"];

        const state = tags["addr:state"];
        const postcode = tags["addr:postcode"];

        const addressParts = [
          houseNumber,
          street,
          city,
          state,
          postcode
        ].filter(Boolean);

        return {
          name:
            tags.name ||
            tags["official_name"] ||
            "Local Police Department",

          phone:
            tags.phone ||
            tags["contact:phone"] ||
            "",

          address:
            addressParts.length > 0
              ? addressParts.join(", ")
              : "",

          website:
            tags.website ||
            tags["contact:website"] ||
            "",

          distance
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    if (policePlaces.length === 0) {
      return res.status(404).json({
        error:
          "We could not find a nearby police department for this ZIP code."
      });
    }

    const nearest = policePlaces[0];

    res.json({
      result: {
        name: nearest.name,
        phone: nearest.phone || "Phone number not listed",
        address:
          nearest.address || "Address not listed",
        website: nearest.website || "",
        distance: `${nearest.distance.toFixed(1)} miles away`,
        note:
          "This result is based on publicly available police-location data. Confirm the department's phone number and address before calling. For emergencies, always call 911."
      }
    });
  } catch (error) {
    console.error(
      "Police lookup error:",
      error.message
    );

    res.status(500).json({
      error:
        "Police lookup is temporarily unavailable. Please try again."
    });
  }
});

/* -------------------------------------------------------
   CONTACT YOUR BANK
   Bank name -> FDIC public institution data
------------------------------------------------------- */

app.post("/api/bank-contact", async (req, res) => {
  try {
    const { bankName } = req.body;

    if (!bankName || typeof bankName !== "string") {
      return res.status(400).json({
        error: "Please provide a bank name."
      });
    }

    const cleanedBankName = bankName
      .trim()
      .replace(/"/g, "");

    if (!cleanedBankName) {
      return res.status(400).json({
        error: "Please provide a valid bank name."
      });
    }

    /*
      FDIC uses ElasticSearch-style filters.
      We first try a phrase search, then a simpler
      token search so inputs like "Chase bank" can
      match "JPMorgan Chase Bank, N.A."
    */

    const searchFilters = [
      `NAME:"${cleanedBankName}"`,
      `NAME:${cleanedBankName.replace(/\s+/g, " AND NAME:")}`
    ];

    let banks = [];

    for (const filter of searchFilters) {
      const fdicUrl =
        "https://api.fdic.gov/banks/institutions?" +
        new URLSearchParams({
          filters: filter,
          fields:
            "NAME,CITY,STNAME,STALP,ZIP,MAIN_PHONE,WEBADDR",
          limit: "25"
        }).toString();

      try {
        const bankData = await fetchJson(fdicUrl, {
          headers: {
            Accept: "application/json"
          }
        });

        banks = Array.isArray(bankData.data)
          ? bankData.data
          : [];

        if (banks.length > 0) {
          break;
        }
      } catch (error) {
        console.error(
          "FDIC search attempt failed:",
          error.message
        );
      }
    }

    if (banks.length === 0) {
      return res.status(404).json({
        error:
          "We could not find that bank in the FDIC public database."
      });
    }

    const normalizedInput = cleanedBankName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(
        (word) =>
          word &&
          !["bank", "the", "na", "n", "a"].includes(word)
      );

    const scoredBanks = banks
      .map((bank) => {
        const bankText = String(
          bank.NAME || ""
        ).toLowerCase();

        const score = normalizedInput.reduce(
          (total, word) =>
            total + (bankText.includes(word) ? 1 : 0),
          0
        );

        return {
          bank,
          score
        };
      })
      .sort(
        (a, b) => b.score - a.score
      );

    const bank = scoredBanks[0].bank;

    const addressParts = [
      bank.CITY,
      bank.STALP,
      bank.ZIP
    ].filter(Boolean);

    let website = bank.WEBADDR || "";

    if (
      website &&
      !/^https?:\/\//i.test(website)
    ) {
      website = `https://${website}`;
    }

    res.json({
      result: {
        name:
          bank.NAME || cleanedBankName,

        phone:
          bank.MAIN_PHONE ||
          "Phone number not listed",

        address:
          addressParts.length > 0
            ? addressParts.join(", ")
            : "Address not listed",

        website,

        note:
          "This is the bank's main phone number from FDIC public data. Before calling, compare it with the number printed on the back of your card or shown on an official bank statement. Never share your PIN, password or OTP."
      }
    });
  } catch (error) {
    console.error(
      "Bank lookup error:",
      error.message
    );

    res.status(500).json({
      error:
        "Bank contact lookup is temporarily unavailable. Please try again."
    });
  }
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(
    `EbookPc AI Backend running on port ${PORT}`
  );
});