import { prisma } from "../database/prisma.js";

const KEY = "SHOW_CUSTOM_ORDER";

export async function isCustomOrderEnabled(): Promise<boolean> {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: KEY },
    });
    if (!setting) {
      return true; // default: tampil
    }
    return setting.value !== "false";
  } catch {
    return true;
  }
}

export async function setCustomOrderEnabled(enabled: boolean): Promise<boolean> {
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value: String(enabled) },
    create: { key: KEY, value: String(enabled) },
  });
  return enabled;
}
