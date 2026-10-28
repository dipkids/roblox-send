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
  const response = await fetchWithRetry(
    "https://users.roblox.com/v1/usernames/users",
    {
      method: "POST",
      headers: ROBLOX_HEADERS,
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Roblox API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    data: {
      id: number;
      name: string;
      displayName: string;
    }[];
  };

  if (!data?.data || data.data.length === 0) {
    return null;
  }

  const user = data.data[0];

  let avatarUrl = "";
  try {
    const avatarResponse = await fetchWithRetry(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png&isCircular=false`,
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
    console.warn(`⚠️ Gagal mengambil avatar untuk Roblox user ${user.id}:`, err);
  }

  return {
    id: user.id,
    username: user.name,
    displayName: user.displayName,
    avatarUrl,
  };
}
