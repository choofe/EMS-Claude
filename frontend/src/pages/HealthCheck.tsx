import { useEffect, useState } from "react";
import {
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import { getLiveness, getReadiness } from "../api/health";

type CheckState =
  | { status: "loading" }
  | { status: "ok"; detail: string }
  | { status: "error"; detail: string };

function StatusRow({ label, state }: { label: string; state: CheckState }) {
  const chipProps =
    state.status === "loading"
      ? { label: "در حال بررسی...", color: "default" as const }
      : state.status === "ok"
        ? { label: "سالم", color: "success" as const }
        : { label: "خطا", color: "error" as const };

  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      sx={{ py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
    >
      <Box>
        <Typography variant="subtitle1">{label}</Typography>
        {state.status !== "loading" && (
          <Typography variant="body2" color="text.secondary">
            {state.detail}
          </Typography>
        )}
      </Box>
      <Chip size="small" {...chipProps} />
    </Stack>
  );
}

/**
 * Phase 1 skeleton's only page: confirms the frontend can actually reach
 * the backend's two health endpoints. Domain screens (login, equipment
 * search, report entry, ...) start in Phase 3 onward per the phase plan —
 * intentionally not stubbed here to avoid dead/misleading code.
 */
export function HealthCheck() {
  const [live, setLive] = useState<CheckState>({ status: "loading" });
  const [ready, setReady] = useState<CheckState>({ status: "loading" });

  useEffect(() => {
    getLiveness()
      .then((res) => setLive({ status: "ok", detail: `${res.app} — ${res.environment}` }))
      .catch((err: Error) => setLive({ status: "error", detail: err.message }));

    getReadiness()
      .then((res) => setReady({ status: "ok", detail: `پایگاه‌داده: ${res.database}` }))
      .catch((err: Error) => setReady({ status: "error", detail: err.message }));
  }, []);

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "grey.50",
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 480, width: "100%" }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            سامانه گزارش‌دهی نگهداری تجهیزات
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            اسکلت اولیه — بررسی اتصال به بک‌اند
          </Typography>
          <StatusRow label="سرویس (Liveness)" state={live} />
          <StatusRow label="پایگاه‌داده (Readiness)" state={ready} />
        </CardContent>
      </Card>
    </Box>
  );
}
