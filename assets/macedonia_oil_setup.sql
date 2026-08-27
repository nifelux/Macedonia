-- Macedonia — Supabase/Postgres setup
-- Run in the Supabase SQL editor as the project owner, in a new/empty project.
-- This script intentionally creates no customer, wallet, product, or payment seed data.

begin;

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Common helpers
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Core identity and configuration
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  phone text,
  referral_code text not null unique,
  referred_by uuid references public.profiles(id) on delete set null,
  vip_level integer not null default 0 check (vip_level >= 0 and vip_level <= 10),
  is_admin boolean not null default false,
  is_active boolean not null default true,
  monnify_account_number text,
  monnify_bank_name text,
  monnify_bank_code text,
  monnify_account_ref text unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.site_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references public.profiles(id) on delete set null
);

-- These helpers follow the table definitions because PostgreSQL validates their
-- referenced relations when each function is created in a clean installation.
create or replace function public.setting_value(p_key text, p_default text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.site_settings where key = p_key), p_default);
$$;

-- Creates an externally shareable code without exposing a sequential user ID.
create or replace function public.generate_referral_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  loop
    v_code := 'AO' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.profiles where referral_code = v_code);
  end loop;
  return v_code;
end;
$$;

create table if not exists public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric(18,2) not null default 0 check (balance >= 0),
  total_deposit numeric(18,2) not null default 0 check (total_deposit >= 0),
  total_profit numeric(18,2) not null default 0 check (total_profit >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- These are configuration defaults, not customer or product seed data.
insert into public.site_settings(key, value) values
  ('deposit_method', 'manual'),
  ('withdrawals_locked', 'false'),
  ('min_withdraw', '1000'),
  ('max_withdraw', '0'),
  ('welcome_bonus_enabled', 'false'),
  ('welcome_bonus_amount', '0'),
  ('daily_checkin_amount', '50'),
  ('require_invest_before_withdraw', 'false'),
  ('require_active_referral_to_withdraw', 'false'),
  ('vip_enabled', 'true'),
  ('withdrawal_fee_percent', '0'),
  ('referral_levels', '3'),
  ('referral_l1_percent', '0'),
  ('referral_l2_percent', '0'),
  ('referral_l3_percent', '0')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Package catalogue, ownership, wallet ledger, and referrals
-- -----------------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  type text not null default 'oil_package',
  vip_level integer not null default 0 check (vip_level >= 0 and vip_level <= 10),
  price numeric(18,2) not null check (price > 0),
  daily_income numeric(18,2) not null default 0 check (daily_income >= 0),
  duration_days integer not null check (duration_days > 0),
  total_return numeric(18,2),
  max_purchases_per_user integer not null default 2 check (max_purchases_per_user > 0),
  status text not null default 'active' check (status in ('active', 'locked', 'inactive')),
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.user_products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  price_paid numeric(18,2) not null check (price_paid > 0),
  daily_income numeric(18,2) not null default 0 check (daily_income >= 0),
  duration_days integer not null check (duration_days > 0),
  days_collected integer not null default 0 check (days_collected >= 0),
  total_collected numeric(18,2) not null default 0 check (total_collected >= 0),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  activated_at timestamptz not null default timezone('utc', now()),
  last_collected_on date,
  next_collection_on date not null default (current_date + 1),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (days_collected <= duration_days)
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  type text not null check (type in (
    'deposit', 'product_purchase', 'daily_income', 'referral_reward',
    'welcome_bonus', 'daily_bonus', 'gift_code', 'withdrawal_request',
    'withdrawal_refund', 'admin_credit', 'admin_debit'
  )),
  amount numeric(18,2) not null check (amount <> 0),
  balance_after numeric(18,2),
  description text not null,
  external_reference text unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.profiles(id) on delete restrict,
  source_user_id uuid not null references public.profiles(id) on delete restrict,
  user_product_id uuid not null references public.user_products(id) on delete restrict,
  level integer not null check (level between 1 and 3),
  rate_percent numeric(7,4) not null check (rate_percent >= 0 and rate_percent <= 100),
  amount numeric(18,2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_product_id, level)
);

-- -----------------------------------------------------------------------------
-- Funding, payouts, bank accounts, bonuses, notices, and administration
-- -----------------------------------------------------------------------------

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(18,2) not null check (amount > 0),
  reference text not null unique,
  narration text,
  sender_name text,
  method text not null default 'manual' check (method in ('manual', 'monnify', 'targetgrowths')),
  provider text,
  provider_identifier text unique,
  provider_reference text,
  provider_status text,
  provider_error text,
  provider_response jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'rejected', 'cancelled')),
  paid_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists deposits_provider_reference_key
  on public.deposits(provider_reference)
  where provider_reference is not null;

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(18,2) not null check (amount > 0),
  fee_amount numeric(18,2) not null default 0 check (fee_amount >= 0),
  net_amount numeric(18,2) not null check (net_amount >= 0),
  bank_name text not null,
  bank_id text,
  account_number text not null,
  account_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed', 'rejected', 'failed', 'cancelled')),
  provider text,
  provider_identifier text unique,
  provider_reference text,
  provider_status text,
  provider_response jsonb not null default '{}'::jsonb,
  note text,
  processed_by uuid references public.profiles(id) on delete set null,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (fee_amount <= amount),
  check (net_amount = amount - fee_amount)
);

create unique index if not exists withdrawals_provider_reference_key
  on public.withdrawals(provider_reference)
  where provider_reference is not null;

create table if not exists public.bank_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  bank_name text not null,
  bank_id text,
  account_number text not null,
  account_name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists bank_cards_one_default_per_user
  on public.bank_cards(user_id)
  where is_default;

create table if not exists public.daily_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  date date not null default current_date,
  amount numeric(18,2) not null default 0 check (amount >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, date)
);

create table if not exists public.gift_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  amount numeric(18,2) not null check (amount > 0),
  max_uses integer not null default 1 check (max_uses > 0),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  status text not null default 'active' check (status in ('active', 'inactive', 'used')),
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.gift_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  gift_code_id uuid not null references public.gift_codes(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(18,2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (gift_code_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  title text not null,
  content text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

-- -----------------------------------------------------------------------------
-- Supporting indexes
-- -----------------------------------------------------------------------------

create index if not exists profiles_referred_by_idx on public.profiles(referred_by);
create index if not exists products_catalog_idx on public.products(status, vip_level, price, sort_order);
create index if not exists user_products_user_status_idx on public.user_products(user_id, status, created_at desc);
create index if not exists user_products_collection_idx on public.user_products(status, next_collection_on)
  where status = 'active';
create index if not exists wallet_transactions_user_created_idx on public.wallet_transactions(user_id, created_at desc);
create index if not exists deposits_user_status_idx on public.deposits(user_id, status, created_at desc);
create index if not exists withdrawals_user_status_idx on public.withdrawals(user_id, status, created_at desc);
create index if not exists messages_user_created_idx on public.messages(user_id, created_at desc);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index if not exists referral_rewards_referrer_idx on public.referral_rewards(referrer_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Timestamp triggers
-- -----------------------------------------------------------------------------

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists site_settings_set_updated_at on public.site_settings;
create trigger site_settings_set_updated_at before update on public.site_settings
for each row execute function public.set_updated_at();

drop trigger if exists wallets_set_updated_at on public.wallets;
create trigger wallets_set_updated_at before update on public.wallets
for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists user_products_set_updated_at on public.user_products;
create trigger user_products_set_updated_at before update on public.user_products
for each row execute function public.set_updated_at();

drop trigger if exists deposits_set_updated_at on public.deposits;
create trigger deposits_set_updated_at before update on public.deposits
for each row execute function public.set_updated_at();

drop trigger if exists withdrawals_set_updated_at on public.withdrawals;
create trigger withdrawals_set_updated_at before update on public.withdrawals
for each row execute function public.set_updated_at();

drop trigger if exists bank_cards_set_updated_at on public.bank_cards;
create trigger bank_cards_set_updated_at before update on public.bank_cards
for each row execute function public.set_updated_at();

drop trigger if exists gift_codes_set_updated_at on public.gift_codes;
create trigger gift_codes_set_updated_at before update on public.gift_codes
for each row execute function public.set_updated_at();

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at before update on public.messages
for each row execute function public.set_updated_at();

drop trigger if exists notifications_set_updated_at on public.notifications;
create trigger notifications_set_updated_at before update on public.notifications
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Auth profile and wallet bootstrap
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral_input text;
  v_referrer_id uuid;
  v_welcome_enabled boolean;
  v_welcome_amount numeric(18,2);
begin
  v_referral_input := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
  if v_referral_input <> '' then
    select id into v_referrer_id
    from public.profiles
    where referral_code = v_referral_input and is_active = true;
  end if;

  insert into public.profiles (
    id, email, full_name, phone, referral_code, referred_by
  ) values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    public.generate_referral_code(),
    v_referrer_id
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  select coalesce(value = 'true', false) into v_welcome_enabled
  from public.site_settings where key = 'welcome_bonus_enabled';
  select coalesce(nullif(value, '')::numeric, 0) into v_welcome_amount
  from public.site_settings where key = 'welcome_bonus_amount';

  if coalesce(v_welcome_enabled, false) and coalesce(v_welcome_amount, 0) > 0 then
    update public.wallets
    set balance = balance + v_welcome_amount,
        total_profit = total_profit + v_welcome_amount
    where user_id = new.id;

    insert into public.wallet_transactions (
      user_id, type, amount, description, external_reference
    ) values (
      new.id, 'welcome_bonus', v_welcome_amount, 'Account welcome bonus', 'welcome:' || new.id::text
    ) on conflict (external_reference) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Core business procedures
-- -----------------------------------------------------------------------------

create or replace function public.purchase_product(p_user_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_wallet public.wallets%rowtype;
  v_profile public.profiles%rowtype;
  v_user_product_id uuid;
  v_count integer;
  v_vip_enabled boolean;
  v_referrer_1 uuid;
  v_referrer_2 uuid;
  v_referrer_3 uuid;
  v_levels integer;
  v_rate numeric(7,4);
  v_reward numeric(18,2);
  v_reward_id uuid;
  v_level integer;
  v_referrer uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'product_not_found');
  end if;
  if v_product.status = 'locked' then
    return jsonb_build_object('ok', false, 'error', 'product_locked');
  end if;
  if v_product.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'product_unavailable');
  end if;

  select * into v_profile from public.profiles where id = p_user_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'account_inactive');
  end if;

  v_vip_enabled := coalesce(public.setting_value('vip_enabled', 'true') = 'true', true);
  if v_product.vip_level > 0 and not v_vip_enabled then
    return jsonb_build_object('ok', false, 'error', 'vip_disabled');
  end if;
  if v_product.vip_level > v_profile.vip_level then
    return jsonb_build_object('ok', false, 'error', 'vip_level_required');
  end if;

  select count(*) into v_count
  from public.user_products
  where user_id = p_user_id and product_id = p_product_id and status <> 'cancelled';
  if v_count >= v_product.max_purchases_per_user then
    return jsonb_build_object('ok', false, 'error', 'purchase_limit_reached');
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found or v_wallet.balance < v_product.price then
    return jsonb_build_object('ok', false, 'error', 'insufficient_balance');
  end if;

  update public.wallets
  set balance = balance - v_product.price
  where user_id = p_user_id;

  insert into public.user_products (
    user_id, product_id, price_paid, daily_income, duration_days, next_collection_on
  ) values (
    p_user_id, p_product_id, v_product.price, v_product.daily_income, v_product.duration_days, current_date + 1
  ) returning id into v_user_product_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id,
    'product_purchase',
    -v_product.price,
    v_wallet.balance - v_product.price,
    'Oil package activated: ' || v_product.name,
    'purchase:' || v_user_product_id::text,
    jsonb_build_object('product_id', p_product_id, 'user_product_id', v_user_product_id)
  );

  -- Referral commissions are created at purchase time and are idempotent per level.
  v_referrer_1 := v_profile.referred_by;
  select referred_by into v_referrer_2 from public.profiles where id = v_referrer_1;
  select referred_by into v_referrer_3 from public.profiles where id = v_referrer_2;
  v_levels := coalesce(public.setting_value('referral_levels', '3')::integer, 3);

  for v_level in 1..least(v_levels, 3) loop
    v_referrer := case v_level
      when 1 then v_referrer_1
      when 2 then v_referrer_2
      else v_referrer_3
    end;
    if v_referrer is null then
      continue;
    end if;

    v_rate := case v_level
      when 1 then coalesce(public.setting_value('referral_l1_percent', '0')::numeric, 0)
      when 2 then coalesce(public.setting_value('referral_l2_percent', '0')::numeric, 0)
      else coalesce(public.setting_value('referral_l3_percent', '0')::numeric, 0)
    end;
    v_reward := round(v_product.price * v_rate / 100, 2);
    if v_reward <= 0 then
      continue;
    end if;

    insert into public.referral_rewards (
      referrer_id, source_user_id, user_product_id, level, rate_percent, amount
    ) values (
      v_referrer, p_user_id, v_user_product_id, v_level, v_rate, v_reward
    ) on conflict (user_product_id, level) do nothing
    returning id into v_reward_id;

    if v_reward_id is not null then
      update public.wallets
      set balance = balance + v_reward,
          total_profit = total_profit + v_reward
      where user_id = v_referrer;

      insert into public.wallet_transactions (
        user_id, type, amount, description, external_reference, metadata
      ) values (
        v_referrer,
        'referral_reward',
        v_reward,
        'Referral reward from package activation',
        'referral:' || v_user_product_id::text || ':' || v_level::text,
        jsonb_build_object('source_user_id', p_user_id, 'user_product_id', v_user_product_id, 'level', v_level)
      );
    end if;
    v_reward_id := null;
  end loop;

  return jsonb_build_object('ok', true, 'user_product_id', v_user_product_id);
end;
$$;

create or replace function public.process_deposit(
  p_reference text,
  p_amount numeric,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deposit public.deposits%rowtype;
  v_wallet public.wallets%rowtype;
begin
  select * into v_deposit from public.deposits where reference = p_reference for update;
  if not found then
    return jsonb_build_object('ok', false, 'success', false, 'error', 'deposit_not_found');
  end if;
  if v_deposit.status = 'completed' then
    return jsonb_build_object('ok', true, 'success', true, 'already_processed', true, 'deposit_id', v_deposit.id);
  end if;
  if v_deposit.status in ('rejected', 'cancelled') then
    return jsonb_build_object('ok', false, 'success', false, 'error', 'deposit_not_pending');
  end if;
  if round(v_deposit.amount, 2) <> round(p_amount, 2) then
    return jsonb_build_object('ok', false, 'success', false, 'error', 'amount_mismatch');
  end if;

  select * into v_wallet from public.wallets where user_id = v_deposit.user_id for update;
  if not found then
    insert into public.wallets(user_id) values (v_deposit.user_id)
    on conflict (user_id) do nothing;
    select * into v_wallet from public.wallets where user_id = v_deposit.user_id for update;
  end if;

  update public.wallets
  set balance = balance + v_deposit.amount,
      total_deposit = total_deposit + v_deposit.amount
  where user_id = v_deposit.user_id;

  update public.deposits
  set status = 'completed',
      paid_at = coalesce(paid_at, timezone('utc', now())),
      provider_response = case when p_payload = '{}'::jsonb then provider_response else p_payload end
  where id = v_deposit.id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    v_deposit.user_id,
    'deposit',
    v_deposit.amount,
    v_wallet.balance + v_deposit.amount,
    'Deposit credited: ' || v_deposit.reference,
    'deposit:' || v_deposit.reference,
    jsonb_build_object('deposit_id', v_deposit.id, 'method', v_deposit.method)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'success', true, 'deposit_id', v_deposit.id);
end;
$$;

create or replace function public.process_monnify_deposit(
  p_user_id uuid,
  p_amount numeric,
  p_monnify_ref text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_deposit_id uuid;
begin
  if p_amount <= 0 or coalesce(trim(p_monnify_ref), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_payment_payload');
  end if;
  if exists (select 1 from public.deposits where provider_reference = p_monnify_ref) then
    return jsonb_build_object('ok', true, 'already_processed', true);
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  end if;

  insert into public.deposits (
    user_id, amount, reference, method, provider, provider_reference, provider_status, provider_response, status, paid_at
  ) values (
    p_user_id, p_amount, 'MON-' || p_monnify_ref, 'monnify', 'monnify', p_monnify_ref, 'completed', p_payload, 'completed', timezone('utc', now())
  ) returning id into v_deposit_id;

  update public.wallets
  set balance = balance + p_amount,
      total_deposit = total_deposit + p_amount
  where user_id = p_user_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id, 'deposit', p_amount, v_wallet.balance + p_amount,
    'Monnify deposit credited', 'monnify:' || p_monnify_ref,
    jsonb_build_object('deposit_id', v_deposit_id, 'provider_reference', p_monnify_ref)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'deposit_id', v_deposit_id);
end;
$$;

create or replace function public.request_withdrawal(
  p_user_id uuid,
  p_amount numeric,
  p_bank_name text,
  p_account_number text,
  p_account_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets%rowtype;
  v_min numeric(18,2);
  v_max numeric(18,2);
  v_fee_percent numeric(7,4);
  v_fee numeric(18,2);
  v_net numeric(18,2);
  v_withdrawal_id uuid;
  v_requires_product boolean;
  v_requires_referral boolean;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if coalesce(public.setting_value('withdrawals_locked', 'false') = 'true', false) then
    return jsonb_build_object('ok', false, 'error', 'withdrawals_locked');
  end if;

  v_min := coalesce(public.setting_value('min_withdraw', '1000')::numeric, 1000);
  v_max := coalesce(public.setting_value('max_withdraw', '0')::numeric, 0);
  if p_amount < v_min then
    return jsonb_build_object('ok', false, 'error', 'below_minimum', 'min', v_min);
  end if;
  if v_max > 0 and p_amount > v_max then
    return jsonb_build_object('ok', false, 'error', 'above_maximum', 'max', v_max);
  end if;

  v_requires_product := coalesce(public.setting_value('require_invest_before_withdraw', 'false') = 'true', false);
  if v_requires_product and not exists (
    select 1 from public.user_products where user_id = p_user_id and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'error', 'investment_required');
  end if;

  v_requires_referral := coalesce(public.setting_value('require_active_referral_to_withdraw', 'false') = 'true', false);
  if v_requires_referral and not exists (
    select 1
    from public.profiles p
    where p.referred_by = p_user_id
      and exists (select 1 from public.user_products up where up.user_id = p.id)
  ) then
    return jsonb_build_object('ok', false, 'error', 'active_referral_required');
  end if;

  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found or v_wallet.balance < p_amount then
    return jsonb_build_object('ok', false, 'error', 'insufficient_balance');
  end if;

  v_fee_percent := coalesce(public.setting_value('withdrawal_fee_percent', '0')::numeric, 0);
  v_fee := round(p_amount * v_fee_percent / 100, 2);
  v_net := p_amount - v_fee;

  update public.wallets
  set balance = balance - p_amount
  where user_id = p_user_id;

  insert into public.withdrawals (
    user_id, amount, fee_amount, net_amount, bank_name, account_number, account_name
  ) values (
    p_user_id, p_amount, v_fee, v_net, trim(p_bank_name), trim(p_account_number), trim(p_account_name)
  ) returning id into v_withdrawal_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id,
    'withdrawal_request',
    -p_amount,
    v_wallet.balance - p_amount,
    'Withdrawal request submitted',
    'withdrawal:' || v_withdrawal_id::text,
    jsonb_build_object('withdrawal_id', v_withdrawal_id, 'fee_amount', v_fee, 'net_amount', v_net)
  );

  return jsonb_build_object('ok', true, 'withdrawal_id', v_withdrawal_id, 'amount', p_amount, 'fee', v_fee, 'net', v_net);
end;
$$;

create or replace function public.finalize_targetgrowths_withdrawal(
  p_withdrawal_id uuid,
  p_success boolean,
  p_provider_reference text,
  p_provider_status text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_withdrawal public.withdrawals%rowtype;
  v_wallet public.wallets%rowtype;
begin
  select * into v_withdrawal from public.withdrawals where id = p_withdrawal_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  end if;
  if v_withdrawal.status = 'completed' then
    return jsonb_build_object('ok', true, 'already_processed', true, 'status', 'completed');
  end if;

  if p_success then
    update public.withdrawals
    set status = 'completed',
        provider_reference = coalesce(p_provider_reference, provider_reference),
        provider_status = coalesce(p_provider_status, 'completed'),
        provider_response = case when p_payload = '{}'::jsonb then provider_response else p_payload end,
        processed_at = coalesce(processed_at, timezone('utc', now()))
    where id = p_withdrawal_id;
    return jsonb_build_object('ok', true, 'status', 'completed');
  end if;

  if v_withdrawal.status not in ('pending', 'approved') then
    return jsonb_build_object('ok', true, 'already_processed', true, 'status', v_withdrawal.status);
  end if;

  select * into v_wallet from public.wallets where user_id = v_withdrawal.user_id for update;
  update public.wallets
  set balance = balance + v_withdrawal.amount
  where user_id = v_withdrawal.user_id;

  update public.withdrawals
  set status = 'rejected',
      provider_reference = coalesce(p_provider_reference, provider_reference),
      provider_status = coalesce(p_provider_status, 'rejected'),
      provider_response = case when p_payload = '{}'::jsonb then provider_response else p_payload end,
      processed_at = timezone('utc', now())
  where id = p_withdrawal_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    v_withdrawal.user_id,
    'withdrawal_refund',
    v_withdrawal.amount,
    v_wallet.balance + v_withdrawal.amount,
    'Withdrawal request refunded',
    'withdrawal-refund:' || v_withdrawal.id::text,
    jsonb_build_object('withdrawal_id', v_withdrawal.id, 'provider_status', p_provider_status)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'status', 'rejected', 'refunded', true);
end;
$$;

create or replace function public.claim_daily_bonus(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(18,2);
  v_checkin_id uuid;
  v_wallet public.wallets%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_amount := coalesce(public.setting_value('daily_checkin_amount', '50')::numeric, 50);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'daily_bonus_disabled');
  end if;

  insert into public.wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'wallet_not_found');
  end if;

  insert into public.daily_checkins(user_id, date, amount)
  values (p_user_id, current_date, v_amount)
  on conflict (user_id, date) do nothing
  returning id into v_checkin_id;
  if v_checkin_id is null then
    return jsonb_build_object('ok', false, 'error', 'already_claimed');
  end if;

  update public.wallets
  set balance = balance + v_amount,
      total_profit = total_profit + v_amount
  where user_id = p_user_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id, 'daily_bonus', v_amount, v_wallet.balance + v_amount,
    'Daily account check-in bonus', 'checkin:' || p_user_id::text || ':' || current_date::text,
    jsonb_build_object('checkin_id', v_checkin_id, 'date', current_date)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'amount', v_amount, 'checkin_id', v_checkin_id);
end;
$$;

create or replace function public.redeem_gift_code(p_user_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_gift public.gift_codes%rowtype;
  v_wallet public.wallets%rowtype;
  v_redemption_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_code = '' then
    return jsonb_build_object('ok', false, 'error', 'code_required');
  end if;

  select * into v_gift from public.gift_codes where code = v_code for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_gift_code');
  end if;
  if v_gift.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'gift_code_inactive');
  end if;
  if v_gift.expires_at is not null and v_gift.expires_at < timezone('utc', now()) then
    return jsonb_build_object('ok', false, 'error', 'gift_code_expired');
  end if;
  if v_gift.uses >= v_gift.max_uses then
    return jsonb_build_object('ok', false, 'error', 'gift_code_fully_used');
  end if;

  insert into public.wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_wallet from public.wallets where user_id = p_user_id for update;

  insert into public.gift_code_redemptions(gift_code_id, user_id, amount)
  values (v_gift.id, p_user_id, v_gift.amount)
  on conflict (gift_code_id, user_id) do nothing
  returning id into v_redemption_id;
  if v_redemption_id is null then
    return jsonb_build_object('ok', false, 'error', 'gift_code_already_redeemed');
  end if;

  update public.gift_codes
  set uses = uses + 1,
      status = case when uses + 1 >= max_uses then 'used' else status end
  where id = v_gift.id;
  update public.wallets set balance = balance + v_gift.amount where user_id = p_user_id;

  insert into public.wallet_transactions (
    user_id, type, amount, balance_after, description, external_reference, metadata
  ) values (
    p_user_id, 'gift_code', v_gift.amount, v_wallet.balance + v_gift.amount,
    'Gift code redeemed: ' || v_gift.code,
    'gift:' || v_gift.id::text || ':' || p_user_id::text,
    jsonb_build_object('gift_code_id', v_gift.id, 'gift_code', v_gift.code, 'redemption_id', v_redemption_id)
  ) on conflict (external_reference) do nothing;

  return jsonb_build_object('ok', true, 'amount', v_gift.amount, 'code', v_gift.code, 'redemption_id', v_redemption_id);
end;
$$;

-- Invoke this routine from a trusted scheduled job once per day. It is not
-- scheduled here because deployment environments differ.
create or replace function public.collect_due_package_income(p_as_of date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.user_products%rowtype;
  v_wallet public.wallets%rowtype;
  v_days integer;
  v_count integer := 0;
begin
  for v_package in
    select * from public.user_products
    where status = 'active'
      and next_collection_on <= p_as_of
      and days_collected < duration_days
    for update skip locked
  loop
    select * into v_wallet from public.wallets where user_id = v_package.user_id for update;
    v_days := v_package.days_collected + 1;

    update public.wallets
    set balance = balance + v_package.daily_income,
        total_profit = total_profit + v_package.daily_income
    where user_id = v_package.user_id;

    update public.user_products
    set days_collected = v_days,
        total_collected = total_collected + v_package.daily_income,
        last_collected_on = p_as_of,
        next_collection_on = p_as_of + 1,
        status = case when v_days >= duration_days then 'completed' else 'active' end,
        completed_at = case when v_days >= duration_days then timezone('utc', now()) else completed_at end
    where id = v_package.id;

    insert into public.wallet_transactions (
      user_id, type, amount, balance_after, description, external_reference, metadata
    ) values (
      v_package.user_id,
      'daily_income',
      v_package.daily_income,
      v_wallet.balance + v_package.daily_income,
      'Daily package credit',
      'income:' || v_package.id::text || ':' || p_as_of::text,
      jsonb_build_object('user_product_id', v_package.id, 'collection_date', p_as_of)
    ) on conflict (external_reference) do nothing;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'processed', v_count, 'as_of', p_as_of);
end;
$$;

-- -----------------------------------------------------------------------------
-- Row-level security and explicit grants
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.products enable row level security;
alter table public.user_products enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.deposits enable row level security;
alter table public.withdrawals enable row level security;
alter table public.bank_cards enable row level security;
alter table public.daily_checkins enable row level security;
alter table public.gift_code_redemptions enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.gift_codes enable row level security;
alter table public.referral_rewards enable row level security;
alter table public.site_settings enable row level security;
alter table public.admin_audit_logs enable row level security;

drop policy if exists profiles_owner_select on public.profiles;
create policy profiles_owner_select on public.profiles for select to authenticated
using (id = auth.uid());
drop policy if exists profiles_owner_update on public.profiles;
create policy profiles_owner_update on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_anon_referral_lookup on public.profiles;
create policy profiles_anon_referral_lookup on public.profiles for select to anon
using (is_active = true and referral_code is not null);

drop policy if exists wallets_owner_select on public.wallets;
create policy wallets_owner_select on public.wallets for select to authenticated
using (user_id = auth.uid());

drop policy if exists products_authenticated_select on public.products;
create policy products_authenticated_select on public.products for select to authenticated
using (status in ('active', 'locked'));

drop policy if exists user_products_owner_select on public.user_products;
create policy user_products_owner_select on public.user_products for select to authenticated
using (user_id = auth.uid());

drop policy if exists wallet_transactions_owner_select on public.wallet_transactions;
create policy wallet_transactions_owner_select on public.wallet_transactions for select to authenticated
using (user_id = auth.uid());

drop policy if exists deposits_owner_select on public.deposits;
create policy deposits_owner_select on public.deposits for select to authenticated
using (user_id = auth.uid());

drop policy if exists withdrawals_owner_select on public.withdrawals;
create policy withdrawals_owner_select on public.withdrawals for select to authenticated
using (user_id = auth.uid());

drop policy if exists bank_cards_owner_select on public.bank_cards;
create policy bank_cards_owner_select on public.bank_cards for select to authenticated
using (user_id = auth.uid());

drop policy if exists daily_checkins_owner_select on public.daily_checkins;
create policy daily_checkins_owner_select on public.daily_checkins for select to authenticated
using (user_id = auth.uid());

drop policy if exists gift_redemptions_owner_select on public.gift_code_redemptions;
create policy gift_redemptions_owner_select on public.gift_code_redemptions for select to authenticated
using (user_id = auth.uid());

drop policy if exists gift_codes_redeemer_select on public.gift_codes;
create policy gift_codes_redeemer_select on public.gift_codes for select to authenticated
using (
  exists (
    select 1
    from public.gift_code_redemptions r
    where r.gift_code_id = gift_codes.id
      and r.user_id = auth.uid()
  )
);

drop policy if exists messages_visible_to_recipient on public.messages;
create policy messages_visible_to_recipient on public.messages for select to authenticated
using (user_id = auth.uid() or user_id is null);

drop policy if exists notifications_owner_select on public.notifications;
create policy notifications_owner_select on public.notifications for select to authenticated
using (user_id = auth.uid());
drop policy if exists notifications_owner_update on public.notifications;
create policy notifications_owner_update on public.notifications for update to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notifications_owner_delete on public.notifications;
create policy notifications_owner_delete on public.notifications for delete to authenticated
using (user_id = auth.uid());

-- Do not expose operational, provider, or administration tables directly.
revoke all on table public.profiles, public.wallets, public.products, public.user_products,
  public.wallet_transactions, public.deposits, public.withdrawals, public.bank_cards,
  public.daily_checkins, public.gift_code_redemptions, public.messages, public.notifications,
  public.gift_codes, public.referral_rewards, public.site_settings, public.admin_audit_logs
from anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select (id, full_name, referral_code) on public.profiles to anon;
grant select (id, code) on public.gift_codes to authenticated;
grant select on public.profiles, public.wallets, public.products, public.user_products,
  public.wallet_transactions, public.deposits, public.withdrawals, public.bank_cards,
  public.daily_checkins, public.gift_code_redemptions, public.messages, public.notifications
to authenticated;
grant update, delete on public.notifications to authenticated;

revoke all on function public.purchase_product(uuid, uuid) from public;
grant execute on function public.purchase_product(uuid, uuid) to authenticated;

revoke all on function public.process_deposit(text, numeric, jsonb) from public;
revoke all on function public.process_monnify_deposit(uuid, numeric, text, jsonb) from public;
revoke all on function public.request_withdrawal(uuid, numeric, text, text, text) from public;
revoke all on function public.finalize_targetgrowths_withdrawal(uuid, boolean, text, text, jsonb) from public;
revoke all on function public.claim_daily_bonus(uuid) from public;
revoke all on function public.redeem_gift_code(uuid, text) from public;
revoke all on function public.collect_due_package_income(date) from public;

grant execute on function public.process_deposit(text, numeric, jsonb) to service_role;
grant execute on function public.process_monnify_deposit(uuid, numeric, text, jsonb) to service_role;
grant execute on function public.request_withdrawal(uuid, numeric, text, text, text) to service_role;
grant execute on function public.finalize_targetgrowths_withdrawal(uuid, boolean, text, text, jsonb) to service_role;
grant execute on function public.claim_daily_bonus(uuid) to service_role;
grant execute on function public.redeem_gift_code(uuid, text) to service_role;
grant execute on function public.collect_due_package_income(date) to service_role;

commit;
