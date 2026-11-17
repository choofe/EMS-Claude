"""Single list of API routers, shared by app.main and the test app so they can never drift apart."""
from app.api import auth, dashboard, equipment, equipment_import, groups, health, personnel_import, report_types, reports, settings, users

API_ROUTERS = [
    health.router, auth.router, users.router, groups.router, equipment_import.router, personnel_import.router, equipment.router, report_types.router, settings.router,
    dashboard.router, reports.router,
]
