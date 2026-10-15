export interface RobloxProfile {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export async function findRobloxUser(
  username: string,
): Promise<RobloxProfile | null> {
  const response = await fetch(
    "https://users.roblox.com/v1/usernames/users",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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

  const data = await response.json() as {
    data: {
      id: number;
      name: string;
      displayName: string;
    }[];
  };

  if (data.data.length === 0) {
    return null;
  }

  const user = data.data[0];

  const avatarResponse = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png&isCircular=false`,
  );

  let avatarUrl = "";

  if (avatarResponse.ok) {
    const avatarData = await avatarResponse.json() as {
      data: {
        imageUrl: string;
      }[];
    };

    avatarUrl = avatarData.data[0]?.imageUrl ?? "";
  }

  return {
    id: user.id,
    username: user.name,
    displayName: user.displayName,
    avatarUrl,
  };
}
