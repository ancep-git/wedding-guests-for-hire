-- Friends Included finance system: run once in Supabase → SQL Editor → New query → Run.
-- Supabase is the source of truth. Row Level Security is enabled with no
-- policies, so the public anon key cannot read or write anything; only the
-- server (service-role key in Vercel environment variables) can.

create table if not exists employees (
  id   text primary key,
  name text not null,
  role text not null check (role in ('sales', 'expenses', 'manager'))
);

insert into employees (id, name, role) values
  ('richard',    'Richard Darling',          'sales'),
  ('anastasia',  'Anastasia Ferrari',        'sales'),
  ('jeanclaude', 'Jean-Claude Bērziņš',      'sales'),
  ('kevin',      'Kevin von Whatever',       'expenses'),
  ('svetlana',   'Svetlana de Monte Carlo',  'manager')
on conflict (id) do nothing;

-- Telegram accounts that have messaged the bot, and the employee the manager linked them to.
create table if not exists telegram_users (
  user_id      text primary key,
  chat_id      text not null,
  username     text,
  first_name   text,
  employee_id  text references employees(id),
  linked_at    timestamptz,
  last_seen_at timestamptz
);

-- Sales and expenses. The reference is the primary key, so duplicates are impossible.
create table if not exists transactions (
  ref                   text primary key,
  kind                  text not null check (kind in ('sale', 'expense')),
  submitted_at          timestamptz not null default now(),
  submitted_by          text not null references employees(id),
  source                text not null check (source in ('telegram', 'web')),
  origin_chat_id        text,                 -- Telegram chat a bot submission came from
  customer              text,
  project               text check (project in ('A', 'B')),
  description           text not null,
  amount_cents          bigint not null check (amount_cents > 0),
  category              text check (category in ('Materials', 'Travel', 'Other')),
  proposed_split        jsonb,                -- original proposal, hundredths of a percent
  final_split           jsonb,                -- manager's decision
  commission_pool_cents bigint not null default 0,
  commission_cents      jsonb,
  proposed_allocation   text check (proposed_allocation in ('A', 'B', 'OVERHEAD')),
  final_allocation      text check (final_allocation in ('A', 'B', 'OVERHEAD')),
  status                text not null check (status in ('pending', 'approved', 'awaiting_allocation', 'allocated')),
  decided_at            timestamptz,
  decided_by            text references employees(id),
  sync_status           text not null default 'pending',  -- pending | synced | failed
  sync_error            text,
  synced_at             timestamptz,
  notify_status         text not null default 'not_required', -- not_required | pending | sent | failed | no_recipient
  notify_error          text,
  notify_chat_id        text,
  notify_message        text,
  notify_at             timestamptz,
  check ((kind = 'sale'    and customer is not null and project is not null and proposed_split is not null)
      or (kind = 'expense' and category is not null and proposed_allocation is not null))
);

create table if not exists app_settings (
  key   text primary key,
  value jsonb
);

alter table employees      enable row level security;
alter table telegram_users enable row level security;
alter table transactions   enable row level security;
alter table app_settings   enable row level security;
