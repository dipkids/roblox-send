import dns from "node:dns";

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

export interface RobloxProfile {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
}

const ROBLOX_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err: any) {
      lastError = err;
      if (attempt <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

export async function findRobloxUser(
  username: string,
): Promise<RobloxProfile | null> {
  const cleanUsername = username.trim().replace(/^@+/, "");
  if (!cleanUsername) {
    return null;
  }

  let targetUser: { id: number; username: string; displayName: string } | null =
    null;

  // ==========================================
  // STAGE 1: Exact Username Lookup (Bulk API)
  // ==========================================
  try {
    const response = await fetchWithRetry(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: ROBLOX_HEADERS,
        body: JSON.stringify({
          usernames: [cleanUsername],
          excludeBannedUsers: false,
        }),
      },
    );

    if (response.ok) {
      const data = (await response.json()) as {
        data: {
          id: number;
          name: string;
          displayName: string;
          requestedUsername?: string;
        }[];
      };

      if (data?.data && data.data.length > 0) {
        const found = data.data.find(
          (u) =>
            u.name.toLowerCase() === cleanUsername.toLowerCase() ||
            u.requestedUsername?.toLowerCase() === cleanUsername.toLowerCase(),
        );

        if (found) {
          targetUser = {
            id: found.id,
            username: found.name,
            displayName: found.displayName,
          };
        }
      }
    }
  } catch (err) {
    console.warn(
      `⚠️ Stage 1 (usernames/users) gagal untuk ${cleanUsername}:`,
      err,
    );
  }

  // ==========================================
  // STAGE 2: Direct ID / Moderated Pattern
  // e.g. roblox_user_4674896488 or pure digits
  // ==========================================
  if (!targetUser) {
    const idMatch =
      cleanUsername.match(/^roblox_user_(\d+)$/i) ||
      cleanUsername.match(/^(\d{4,16})$/);

    if (idMatch) {
      const userId = idMatch[1];
      try {
        const response = await fetchWithRetry(
          `https://users.roblox.com/v1/users/${userId}`,
          {
            headers: ROBLOX_HEADERS,
          },
        );

        if (response.ok) {
          const user = (await response.json()) as {
            id: number;
            name: string;
            displayName: string;
          };

          if (user?.id) {
            targetUser = {
              id: user.id,
              username: user.name,
              displayName: user.displayName,
            };
          }
        }
      } catch (err) {
        console.warn(
          `⚠️ Stage 2 (direct ID) gagal untuk ${cleanUsername}:`,
          err,
        );
      }
    }
  }

  // ==========================================
  // STAGE 3: Roblox Search API (Web Search Fallback)
  // Menemukan user dengan underscore / moderated / previous username
  // ==========================================
  if (!targetUser) {
    try {
      const response = await fetchWithRetry(
        `https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(cleanUsername)}&limit=10`,
        {
          headers: ROBLOX_HEADERS,
        },
      );

      if (response.ok) {
        const data = (await response.json()) as {
          data: {
            id: number;
            name: string;
            displayName: string;
            previousUsernames?: string[];
          }[];
        };

        if (data?.data && data.data.length > 0) {
          // Prioritas 1: Exact match username
          let match = data.data.find(
            (u) => u.name.toLowerCase() === cleanUsername.toLowerCase(),
          );

          // Prioritas 2: Match pada previousUsernames
          if (!match) {
            match = data.data.find((u) =>
              u.previousUsernames?.some(
                (p) => p.toLowerCase() === cleanUsername.toLowerCase(),
              ),
            );
          }

          if (match) {
            targetUser = {
              id: match.id,
              username: match.name,
              displayName: match.displayName,
            };
          }
        }
      }
    } catch (err) {
      console.warn(
        `⚠️ Stage 3 (users/search) gagal untuk ${cleanUsername}:`,
        err,
      );
    }
  }

  if (!targetUser) {
    return null;
  }

  // ==========================================
  // STAGE 4: Fetch Avatar Headshot
  // ==========================================
  let avatarUrl = "";
  try {
    const avatarResponse = await fetchWithRetry(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${targetUser.id}&size=150x150&format=Png&isCircular=false`,
      {
        headers: ROBLOX_HEADERS,
      },
    );

    if (avatarResponse.ok) {
      const avatarData = (await avatarResponse.json()) as {
        data: {
          imageUrl: string;
        }[];
      };

      avatarUrl = avatarData.data?.[0]?.imageUrl ?? "";
    }
  } catch (err) {
    console.warn(
      `⚠️ Gagal mengambil avatar untuk Roblox user ${targetUser.id}:`,
      err,
    );
  }

  return {
    id: targetUser.id,
    username: targetUser.username,
    displayName: targetUser.displayName,
    avatarUrl,
  };
}
