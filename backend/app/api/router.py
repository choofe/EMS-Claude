"""Single list of API routers, shared by app.main and the test app so they can never drift apart."""
from app.api import auth, equipment, groups, health, report_types, settings, users

API_ROUTERS = [
    health.router, auth.router, users.router, groups.router, equipment.router, report_types.router, settings.router,
]
