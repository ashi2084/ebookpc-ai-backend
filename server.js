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
   Helper: fetch JSON
------------------------------------------------------- */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return await response.json();
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
   Area + ZIP -> ZIP coordinates -> nearby police
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

    /*
      First find the ZIP/location.

      We include the user's area and ZIP so the result is
      specifically targeted to the United States location.
    */

    const geocodeUrl =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q: `${area}, ${zipCode}, USA`,
        format: "jsonv2",
        addressdetails: "1",
        limit: "1",
        countrycodes: "us"
      }).toString();

    const locations = await fetchJson(geocodeUrl, {
      headers: {
        "User-Agent": "EbookPc/1.0 contact@ebookpc.com"
      }
    });

    if (!locations || locations.length === 0) {
      return res.status(404).json({
        error: "We could not find that ZIP code and area."
      });
    }

    const latitude = Number(locations[0].lat);
    const longitude = Number(locations[0].lon);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(500).json({
        error: "The location could not be determined."
      });
    }

    /*
      Search nearby police locations.

      25 km radius gives us enough coverage around the ZIP.
    */

    const overpassQuery = `
[out:json][timeout:20];

(
  node["amenity"="police"](around:25000,${latitude},${longitude});
  way["amenity"="police"](around:25000,${latitude},${longitude});
  relation["amenity"="police"](around:25000,${latitude},${longitude});
);

out center tags;
`;

    const overpassResponse = await fetch(
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "EbookPc/1.0"
        },
        body: `data=${encodeURIComponent(overpassQuery)}`
      }
    );

    if (!overpassResponse.ok) {
      throw new Error(
        `Police data request failed with status ${overpassResponse.status}`
      );
    }

    const policeData = await overpassResponse.json();

    const policePlaces = (policeData.elements || [])
      .map((place) => {
        const lat = Number(
          place.lat ?? place.center?.lat
        );

        const lon = Number(
          place.lon ?? place.center?.lon
        );

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
          "We could not find a police department in the nearby area."
      });
    }

    const nearest = policePlaces[0];

    res.json({
      result: {
        name: nearest.name,
        phone: nearest.phone || "Phone number not listed",
        address:
          nearest.address ||
          "Address not listed",
        website: nearest.website || "",
        distance:
          nearest.distance < 1
            ? `${nearest.distance.toFixed(1)} miles away`
            : `${nearest.distance.toFixed(1)} miles away`,
        note:
          "Police information is provided from publicly available location data. Please confirm the department's phone number and address before calling. For emergencies, always call 911."
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
      FDIC BankFind provides publicly available
      financial institution information.
    */

    const fdicUrl =
      "https://api.fdic.gov/banks/institutions?" +
      new URLSearchParams({
        filters: `NAME:"${cleanedBankName}"`,
        fields:
          "NAME,CITY,STNAME,STALP,ZIP,MAIN_PHONE,WEBADDR",
        limit: "10"
      }).toString();

    const bankData = await fetchJson(fdicUrl);

    const banks = bankData.data || [];

    if (banks.length === 0) {
      return res.status(404).json({
        error:
          "We could not find that bank in the FDIC public database."
      });
    }

    const bank = banks[0];

    const addressParts = [
      bank.CITY,
      bank.STALP,
      bank.ZIP
    ].filter(Boolean);

    let website = bank.WEBADDR || "";

    if (website && !/^https?:\/\//i.test(website)) {
      website = `https://${website}`;
    }

    res.json({
      result: {
        name:
          bank.NAME ||
          cleanedBankName,

        phone:
          bank.MAIN_PHONE ||
          "Phone number not listed",

        address:
          addressParts.length > 0
            ? addressParts.join(", ")
            : "Address not listed",

        website,

        note:
          "Before calling, compare the number with the number printed on the back of your card or shown on an official bank statement. Never share your PIN, password or OTP."
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