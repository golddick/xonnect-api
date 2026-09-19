// const express = require("express");
// const { z } = require("zod");
// const { asyncHandler } = require("../middleware/auth");
// const { HttpError } = require("../middleware/errorHandler");

// const router = express.Router();

// const offlineLocations = [
//   {
//     display_name: "Lagos, Nigeria",
//     address: { country: "Nigeria", state: "Lagos" },
//     lat: "6.5244",
//     lon: "3.3792",
//   },
//   {
//     display_name: "Ikeja, Lagos, Nigeria",
//     address: { country: "Nigeria", state: "Lagos", city: "Ikeja" },
//     lat: "6.6018",
//     lon: "3.3515",
//   },
//   {
//     display_name: "Abuja, Nigeria",
//     address: { country: "Nigeria", state: "Federal Capital Territory" },
//     lat: "9.0765",
//     lon: "7.3986",
//   },
//   {
//     display_name: "Port Harcourt, Nigeria",
//     address: { country: "Nigeria", state: "Rivers" },
//     lat: "4.8156",
//     lon: "7.0498",
//   },
// ];

// function formatResults(results) {
//   return results.map((result) => {
//     const properties = result.address || {};
//     const address = {
//       country: properties.country,
//       state: properties.state,
//       county: properties.county,
//       city: properties.city,
//       town: properties.town,
//       village: properties.village,
//       road: properties.road,
//       house_number: properties.house_number,
//     };
//     return {
//       display_name: result.display_name,
//       address,
//       lat: String(result.lat),
//       lon: String(result.lon),
//     };
//   });
// }

// router.get(
//   "/search",
//   asyncHandler(async (req, res) => {
//     const { q } = z.object({ q: z.string().trim().min(2) }).parse(req.query);
//     const params = new URLSearchParams({
//       q,
//       format: "jsonv2",
//       addressdetails: "1",
//       limit: "8",
//       "accept-language": "en",
//     });
//     let response;
//     try {
//       response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
//         signal: AbortSignal.timeout(10000),
//         headers: { Accept: "application/json", "User-Agent": "XonnectApp/1.0 (location search)" },
//       });
//     } catch (error) {
//       if (error?.name === "TimeoutError" || error?.name === "AbortError") {
//         response = null;
//       } else {
//         response = null;
//       }
//     }

//     if (!response) {
//       const fallbackResults = offlineLocations.filter((location) =>
//         location.display_name.toLowerCase().includes(q.toLowerCase())
//       );

//       if (fallbackResults.length > 0) {
//         return res.json(formatResults(fallbackResults));
//       }

//       throw new HttpError(502, "Location search is temporarily unavailable");
//     }

//     if (!response.ok) {
//       console.error(`Nominatim location search failed with status ${response.status}`);
//       if (response.status === 429) throw new HttpError(429, "Location search rate limit reached");
//       if (response.status >= 500) throw new HttpError(503, "Location search provider is unavailable");
//       throw new HttpError(502, "Location search is temporarily unavailable");
//     }
//     const data = await response.json();
//     res.json(formatResults(data));
//   })
// );

// module.exports = router;
















const express = require("express");
const { z } = require("zod");
const { asyncHandler } = require("../middleware/auth");
const { HttpError } = require("../middleware/errorHandler");

const router = express.Router();

// Simple fallback locations for local development
const offlineLocations = [
  {
    display_name: "Lagos, Nigeria",
    address: {
      country: "Nigeria",
      state: "Lagos",
    },
    lat: "6.5244",
    lon: "3.3792",
  },
  {
    display_name: "Ikeja, Lagos, Nigeria",
    address: {
      country: "Nigeria",
      state: "Lagos",
      city: "Ikeja",
    },
    lat: "6.6018",
    lon: "3.3515",
  },
  {
    display_name: "Abuja, Nigeria",
    address: {
      country: "Nigeria",
      state: "Federal Capital Territory",
    },
    lat: "9.0765",
    lon: "7.3986",
  },
  {
    display_name: "Port Harcourt, Nigeria",
    address: {
      country: "Nigeria",
      state: "Rivers",
    },
    lat: "4.8156",
    lon: "7.0498",
  },
];

function formatResults(results) {
  return results.map((result) => {
    const properties = result.address || {};

    return {
      display_name: result.display_name,

      address: {
        country: properties.country || null,
        state: properties.state || null,
        county: properties.county || null,
        city: properties.city || null,
        town: properties.town || null,
        village: properties.village || null,
        road: properties.road || null,
        house_number: properties.house_number || null,
      },

      lat: String(result.lat),
      lon: String(result.lon),
    };
  });
}

/**
 * GET /search?q=Lagos
 *
 * Frontend:
 * http://localhost:3000
 *
 * Express:
 * http://localhost:<EXPRESS_PORT>
 *
 * Express -> Nominatim
 */
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    // -----------------------------------------
    // 1. Validate query
    // -----------------------------------------

    const parsed = z
      .object({
        q: z
          .string()
          .trim()
          .min(2, "Search query must contain at least 2 characters"),
      })
      .safeParse(req.query);

    if (!parsed.success) {
      throw new HttpError(400, "A valid location search query is required");
    }

    const { q } = parsed.data;

    console.log(`[Location] Searching for: "${q}"`);

    // -----------------------------------------
    // 2. Build Nominatim URL
    // -----------------------------------------

    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      addressdetails: "1",
      limit: "8",
      "accept-language": "en",
    });

    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search?${params.toString()}`;

    // -----------------------------------------
    // 3. Call Nominatim
    // -----------------------------------------

    let response;

    try {
      response = await fetch(nominatimUrl, {
        method: "GET",

        headers: {
          Accept: "application/json",

          // Identify your application.
          "User-Agent":
            "Xonnect/1.0 (local development; location search)",
        },

        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      console.error("[Location] Nominatim connection failed:", error);

      // -----------------------------------------
      // 4. Local fallback
      // -----------------------------------------

      const fallbackResults = offlineLocations.filter((location) =>
        location.display_name
          .toLowerCase()
          .includes(q.toLowerCase())
      );

      if (fallbackResults.length > 0) {
        console.log(
          `[Location] Using offline fallback for "${q}"`
        );

        return res.json(formatResults(fallbackResults));
      }

      throw new HttpError(
        502,
        "Unable to connect to location provider"
      );
    }

    // -----------------------------------------
    // 5. Handle Nominatim errors
    // -----------------------------------------

    if (!response.ok) {
      let errorBody = "";

      try {
        errorBody = await response.text();
      } catch {
        // Ignore response parsing error
      }

      console.error(
        `[Location] Nominatim returned ${response.status}`,
        errorBody
      );

      // Rate limit
      if (response.status === 429) {
        throw new HttpError(
          429,
          "Location search rate limit reached. Please try again shortly."
        );
      }

      // Server unavailable
      if (response.status >= 500) {
        throw new HttpError(
          503,
          "Location provider is temporarily unavailable."
        );
      }

      throw new HttpError(
        502,
        `Location provider returned status ${response.status}`
      );
    }

    // -----------------------------------------
    // 6. Parse response
    // -----------------------------------------

    let data;

    try {
      data = await response.json();
    } catch (error) {
      console.error(
        "[Location] Failed to parse Nominatim response:",
        error
      );

      throw new HttpError(
        502,
        "Invalid response from location provider"
      );
    }

    // -----------------------------------------
    // 7. Format response
    // -----------------------------------------

    const results = formatResults(data);

    console.log(
      `[Location] Found ${results.length} result(s) for "${q}"`
    );

    // -----------------------------------------
    // 8. Return to Next.js
    // -----------------------------------------

    return res.json(results);
  })
);

module.exports = router;