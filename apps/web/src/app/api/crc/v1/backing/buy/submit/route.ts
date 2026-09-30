import { crcSubmitRoute } from "@/lib/crc-submit-route";

export const dynamic = "force-dynamic";
export async function POST(req: Request) { return crcSubmitRoute(req, "buy"); }
