import { notFound } from "next/navigation";
import { UiDiagnostics } from "@/components/plugins/UiDiagnostics";
import { uiDiagnosticsEnabled } from "@/lib/web-ui-diagnostics-policy";

export const dynamic = "force-dynamic";

export default function PluginsDiagnosticsPage() {
  if (!uiDiagnosticsEnabled(process.env)) notFound();
  return <UiDiagnostics />;
}
