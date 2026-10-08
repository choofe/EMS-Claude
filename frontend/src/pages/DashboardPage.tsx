import { Box, Card, CardContent, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { dashboardApi } from "../api/resources";
import { ErrorAlert, Loading, Ltr, PageHeader } from "../components/common";
import { useLoad } from "../lib/useLoad";
import { toPersianDigits } from "../lib/dates";

const fa = (n: number) => toPersianDigits(String(n));

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography color="text.secondary" variant="body2">{label}</Typography>
        <Typography variant="h4" component="p" sx={{ my: 0.5 }}>{fa(value)}</Typography>
        {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { data, error, loading } = useLoad(() => dashboardApi.summary(), []);
  return (
    <>
      <PageHeader title="داشبورد" />
      <ErrorAlert error={error} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(4, 1fr)" }, mb: 3 }}>
            <Stat label="کاربران فعال" value={data.active_users} hint={`غیرفعال: ${fa(data.inactive_users)}`} />
            <Stat label="تجهیزات فعال" value={data.active_equipment} hint={`غیرفعال: ${fa(data.inactive_equipment)}`} />
            <Stat label="گروه‌های فعال" value={data.active_groups} />
          </Box>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>گروه‌ها</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>کد</TableCell><TableCell>نام</TableCell><TableCell align="center">تجهیزات فعال</TableCell><TableCell align="center">اعضای فعال</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {data.groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell><Ltr>{g.code}</Ltr></TableCell><TableCell>{g.name}</TableCell>
                    <TableCell align="center">{fa(g.active_equipment)}</TableCell><TableCell align="center">{fa(g.active_members)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
            آمار گزارش‌ها (تعداد، خرابی‌ها، ساعت کار) پس از فعال‌شدن ثبت گزارش به این صفحه اضافه می‌شود.
          </Typography>
        </>
      )}
    </>
  );
}
