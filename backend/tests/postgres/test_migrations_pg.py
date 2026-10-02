"""
Migration-chain checks on real Postgres. Deliberately SYNC tests: Alembic's
async env.py calls asyncio.run(), which cannot run inside a running loop.
"""
from alembic import command


def test_no_model_migration_drift(pg_migrated, alembic_cfg):
    """Equivalent of `alembic check`: raises CommandError if models and
    migrations disagree."""
    command.check(alembic_cfg)


def test_latest_revision_downgrade_then_upgrade(pg_migrated, alembic_cfg):
    """The newest revision must be reversible and re-appliable."""
    command.downgrade(alembic_cfg, "-1")
    command.upgrade(alembic_cfg, "head")
