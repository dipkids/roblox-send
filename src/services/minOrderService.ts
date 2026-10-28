import { prisma } from "../database/prisma.js";

const MIN_ROBUX_KEY = "min_robux_amount";
const DEFAULT_MIN_ROBUX = 10; // Standar minimal Roblox Plus transfer

export async function getMinRobuxAmount(): Promise<number> {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: MIN_ROBUX_KEY },
    });

    if (!setting) {
      return DEFAULT_MIN_ROBUX;
    }

    const val = Number(setting.value);
    return Number.isInteger(val) && val > 0 ? val : DEFAULT_MIN_ROBUX;
  } catch {
    return DEFAULT_MIN_ROBUX;
  }
}

export async function setMinRobuxAmount(amount: number): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("Jumlah minimal Robux harus berupa bilangan bulat positif.");
  }

  const setting = await prisma.systemSetting.upsert({
    where: { key: MIN_ROBUX_KEY },
    update: { value: amount.toString() },
    create: { key: MIN_ROBUX_KEY, value: amount.toString() },
  });

  return Number(setting.value);
}
