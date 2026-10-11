-- ARMS legacy schema for PostgreSQL: the three databases recovered from SQL Server,
-- as three schemas in one database. Generated from the MySQL copy on 2026-10-11.
--
-- Postgres cannot join across databases, so what were three databases are three
-- schemas here. Identifiers are lower case (Postgres folds unquoted names), and
-- every text column is case-insensitive, as it was in SQL Server and MySQL.
-- Safe to run on an empty database; it does not drop anything.

CREATE COLLATION IF NOT EXISTS public.arms_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE SCHEMA IF NOT EXISTS nahdis_fsa;
CREATE SCHEMA IF NOT EXISTS schedule8;
CREATE SCHEMA IF NOT EXISTS schedule8data;

CREATE TABLE IF NOT EXISTS nahdis_fsa.abattoirmaster (
  aba_id integer NOT NULL,
  org_id integer,
  aba_registrationnumber varchar(50) COLLATE public.arms_ci,
  aba_zanumber varchar(50) COLLATE public.arms_ci,
  aba_tpcategory varchar(50) COLLATE public.arms_ci,
  aba_provvetservcontnumber varchar(50) COLLATE public.arms_ci,
  aba_throughputqty integer,
  ind_id integer,
  PRIMARY KEY (aba_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.applications (
  app_id integer NOT NULL,
  app_name varchar(50) COLLATE public.arms_ci NOT NULL,
  app_active smallint,
  PRIMARY KEY (app_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.industries (
  ind_id integer NOT NULL,
  ind_name varchar(10) COLLATE public.arms_ci,
  PRIMARY KEY (ind_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.organisation (
  org_id integer NOT NULL,
  ot_id integer,
  org_name varchar(50) COLLATE public.arms_ci,
  reg_id integer,
  org_contactnumber varchar(30) COLLATE public.arms_ci,
  org_contactpersontitle varchar(6) COLLATE public.arms_ci,
  org_contactpersonname varchar(100) COLLATE public.arms_ci,
  org_physicaladdress varchar(500) COLLATE public.arms_ci,
  org_active smallint,
  org_afs smallint,
  PRIMARY KEY (org_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.organisationabattoirlinks (
  org_id integer NOT NULL,
  abattoir_id integer NOT NULL,
  PRIMARY KEY (org_id,abattoir_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.organisationapplications (
  org_id integer NOT NULL,
  app_id integer NOT NULL,
  PRIMARY KEY (org_id,app_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.organisationspecies (
  aba_id integer NOT NULL,
  spc_id integer
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.organisationtype (
  ot_id integer NOT NULL,
  ot_name varchar(50) COLLATE public.arms_ci NOT NULL,
  PRIMARY KEY (ot_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.orgusers (
  org_id integer NOT NULL,
  user_id integer NOT NULL,
  PRIMARY KEY (org_id,user_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.regions (
  reg_id integer NOT NULL,
  reg_name varchar(50) COLLATE public.arms_ci,
  reg_type varchar(50) COLLATE public.arms_ci,
  reg_parentid integer,
  PRIMARY KEY (reg_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.species (
  spc_id integer NOT NULL,
  spc_name varchar(50) COLLATE public.arms_ci NOT NULL,
  ind_id integer,
  PRIMARY KEY (spc_id)
);

CREATE TABLE IF NOT EXISTS nahdis_fsa.users (
  id integer NOT NULL,
  firstname varchar(50) COLLATE public.arms_ci,
  lastname varchar(50) COLLATE public.arms_ci,
  username varchar(50) COLLATE public.arms_ci,
  idnumber varchar(20) COLLATE public.arms_ci,
  contactnumber varchar(11) COLLATE public.arms_ci,
  email varchar(100) COLLATE public.arms_ci NOT NULL,
  emailconfirmed smallint NOT NULL,
  passwordhash text COLLATE public.arms_ci NOT NULL,
  securitystamp bytea NOT NULL,
  acctoken text COLLATE public.arms_ci NOT NULL,
  createdate timestamp(0),
  logindate timestamp(0),
  active smallint NOT NULL,
  isdisabled smallint NOT NULL,
  passwordresettoken text COLLATE public.arms_ci,
  passwordtokentime timestamp(0),
  reg_id integer,
  companyid integer,
  usercompany varchar(50) COLLATE public.arms_ci,
  profilepicture varchar(50) COLLATE public.arms_ci,
  current_aba_id integer,
  current_aba_name varchar(50) COLLATE public.arms_ci,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS schedule8.formproperties (
  fp_id integer NOT NULL,
  frm_id integer NOT NULL,
  fp_doctype varchar(50) COLLATE public.arms_ci,
  fp_docnr varchar(50) COLLATE public.arms_ci,
  fp_ip varchar(50) COLLATE public.arms_ci,
  fp_designedby varchar(50) COLLATE public.arms_ci,
  fp_approvedbyq varchar(50) COLLATE public.arms_ci,
  fp_issuedate timestamp(0),
  fp_effdate timestamp(0),
  fp_revdate timestamp(0),
  fp_revision varchar(50) COLLATE public.arms_ci,
  fp_version integer,
  fp_versiondate timestamp(0),
  PRIMARY KEY (fp_id)
);

CREATE TABLE IF NOT EXISTS schedule8.forms (
  frm_id integer NOT NULL,
  frm_name varchar(50) COLLATE public.arms_ci NOT NULL,
  frm_active smallint,
  frm_version integer,
  PRIMARY KEY (frm_id)
);

CREATE TABLE IF NOT EXISTS schedule8.groups (
  grp_id integer NOT NULL,
  frm_id integer,
  grp_name varchar(50) COLLATE public.arms_ci,
  grp_parentid integer,
  grp_order integer,
  grp_active smallint,
  grp_breakdown smallint,
  grp_other smallint,
  PRIMARY KEY (grp_id)
);

CREATE TABLE IF NOT EXISTS schedule8.items (
  itm_id integer NOT NULL,
  grp_id integer NOT NULL,
  itm_name varchar(100) COLLATE public.arms_ci,
  it_id integer,
  itm_notify smallint,
  itm_order integer,
  itm_active smallint,
  PRIMARY KEY (itm_id)
);

CREATE TABLE IF NOT EXISTS schedule8.itemsspecieslink (
  itm_id integer NOT NULL,
  spc_id integer NOT NULL,
  PRIMARY KEY (itm_id,spc_id)
);

CREATE TABLE IF NOT EXISTS schedule8.itemtypes (
  it_id integer NOT NULL,
  it_typename varchar(50) COLLATE public.arms_ci,
  PRIMARY KEY (it_id)
);

CREATE TABLE IF NOT EXISTS schedule8.lnk_role_permission (
  role_id integer NOT NULL,
  permission_id integer NOT NULL,
  PRIMARY KEY (role_id,permission_id)
);

CREATE TABLE IF NOT EXISTS schedule8.lnk_users_role (
  user_id integer NOT NULL,
  role_id integer NOT NULL,
  PRIMARY KEY (user_id,role_id)
);

CREATE TABLE IF NOT EXISTS schedule8.notificationtemplates (
  nott_id integer NOT NULL,
  nott_type varchar(50) COLLATE public.arms_ci,
  nott_name varchar(50) COLLATE public.arms_ci,
  nott_subject varchar(1000) COLLATE public.arms_ci,
  nott_message text COLLATE public.arms_ci,
  nott_fromaddress varchar(200) COLLATE public.arms_ci,
  nott_toaddress varchar(1000) COLLATE public.arms_ci,
  nott_createfooter smallint,
  nott_active smallint,
  PRIMARY KEY (nott_id)
);

CREATE TABLE IF NOT EXISTS schedule8.notificationtemplates_backup_beforeurlfix (
  nott_id integer NOT NULL,
  nott_type varchar(50) COLLATE public.arms_ci,
  nott_name varchar(50) COLLATE public.arms_ci,
  nott_subject varchar(1000) COLLATE public.arms_ci,
  nott_message text COLLATE public.arms_ci,
  nott_fromaddress varchar(200) COLLATE public.arms_ci,
  nott_toaddress varchar(1000) COLLATE public.arms_ci,
  nott_createfooter smallint,
  nott_active smallint
);

CREATE TABLE IF NOT EXISTS schedule8.otheritems (
  itm_id integer NOT NULL,
  grp_id integer,
  itm_name varchar(50) COLLATE public.arms_ci NOT NULL,
  it_id integer,
  itm_notify smallint,
  itm_order integer,
  itm_active smallint,
  PRIMARY KEY (itm_id)
);

CREATE TABLE IF NOT EXISTS schedule8.parts (
  prt_id integer NOT NULL,
  prt_name varchar(50) COLLATE public.arms_ci,
  prt_type varchar(10) COLLATE public.arms_ci,
  PRIMARY KEY (prt_id)
);

CREATE TABLE IF NOT EXISTS schedule8.permissions (
  permission_id integer NOT NULL,
  permissiondescription varchar(50) COLLATE public.arms_ci NOT NULL,
  description varchar(150) COLLATE public.arms_ci,
  PRIMARY KEY (permission_id)
);

CREATE TABLE IF NOT EXISTS schedule8.reports (
  rpt_id integer NOT NULL,
  rpt_group varchar(20) COLLATE public.arms_ci,
  rpt_name varchar(50) COLLATE public.arms_ci,
  rpt_path varchar(200) COLLATE public.arms_ci NOT NULL,
  rpt_description varchar(500) COLLATE public.arms_ci,
  rpt_active smallint,
  PRIMARY KEY (rpt_id)
);

CREATE TABLE IF NOT EXISTS schedule8.roles (
  role_id integer NOT NULL,
  rolename varchar(50) COLLATE public.arms_ci NOT NULL,
  roledescription varchar(250) COLLATE public.arms_ci,
  issysadmin smallint,
  lastmodified timestamp(0) NOT NULL,
  PRIMARY KEY (role_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.formdata (
  frmd_id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  frm_id integer NOT NULL,
  frmd_revision integer NOT NULL,
  org_id integer NOT NULL,
  org_name varchar(50) COLLATE public.arms_ci NOT NULL,
  frmd_status varchar(10) COLLATE public.arms_ci NOT NULL,
  frmd_startdate timestamp(0) NOT NULL,
  frmd_enddate timestamp(0) NOT NULL,
  usr_id integer NOT NULL,
  frmd_username varchar(100) COLLATE public.arms_ci NOT NULL,
  frmd_aprrovedusername varchar(100) COLLATE public.arms_ci,
  frmd_approveddate timestamp(0),
  frmd_formnotes text COLLATE public.arms_ci,
  frmd_noslaughter smallint NOT NULL,
  frmd_noslaughterreason varchar(500) COLLATE public.arms_ci,
  PRIMARY KEY (frmd_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.formdataitemparts (
  dip_id integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  fdi_id integer NOT NULL,
  dip_name varchar(50) COLLATE public.arms_ci NOT NULL,
  dip_value integer NOT NULL,
  dip_notes varchar(200) COLLATE public.arms_ci,
  prt_id integer NOT NULL,
  PRIMARY KEY (dip_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.formdataitems (
  fdi_id integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  grp_id integer NOT NULL,
  grp_name varchar(50) COLLATE public.arms_ci NOT NULL,
  grp_subid integer NOT NULL,
  grp_subname varchar(50) COLLATE public.arms_ci NOT NULL,
  itm_id integer NOT NULL,
  fdi_item varchar(100) COLLATE public.arms_ci NOT NULL,
  fdi_specie varchar(10) COLLATE public.arms_ci NOT NULL,
  fdi_value varchar(10) COLLATE public.arms_ci,
  fdi_notes text COLLATE public.arms_ci,
  fdi_status varchar(10) COLLATE public.arms_ci NOT NULL,
  frmd_id bigint NOT NULL,
  usr_id integer NOT NULL,
  PRIMARY KEY (fdi_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.formdatasr1link (
  frmd_id integer NOT NULL,
  srf_id integer NOT NULL,
  gridrowindex integer NOT NULL,
  link_id integer NOT NULL,
  isactive smallint NOT NULL,
  issent smallint NOT NULL,
  PRIMARY KEY (link_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.notificationdata (
  not_id bigint NOT NULL,
  not_type varchar(50) COLLATE public.arms_ci NOT NULL,
  not_name varchar(50) COLLATE public.arms_ci,
  not_header varchar(255) COLLATE public.arms_ci,
  not_message varchar(1000) COLLATE public.arms_ci,
  not_time timestamp(0) NOT NULL,
  not_address varchar(50) COLLATE public.arms_ci,
  not_status varchar(10) COLLATE public.arms_ci,
  not_attachment varchar(255) COLLATE public.arms_ci,
  not_user varchar(100) COLLATE public.arms_ci,
  usr_id integer NOT NULL,
  PRIMARY KEY (not_type,not_time,usr_id)
);

CREATE TABLE IF NOT EXISTS schedule8data.srf_sr1formdata (
  srf_id bigint NOT NULL,
  srf_diseasename text COLLATE public.arms_ci,
  srf_reportno text COLLATE public.arms_ci,
  srf_labno text COLLATE public.arms_ci,
  srf_reportdate timestamp(0),
  srf_firstdetectiondate timestamp(0),
  srf_estfirstinfectiondate timestamp(0),
  srf_province text COLLATE public.arms_ci,
  srf_localmunicipality text COLLATE public.arms_ci,
  srf_svarea text COLLATE public.arms_ci,
  srf_geocoordinates text COLLATE public.arms_ci,
  srf_farmname text COLLATE public.arms_ci,
  srf_farmno text COLLATE public.arms_ci,
  srf_ownername text COLLATE public.arms_ci,
  srf_ownercontactno text COLLATE public.arms_ci,
  srf_species text COLLATE public.arms_ci,
  srf_outbreaks integer,
  srf_cases integer,
  srf_deaths integer,
  srf_destroyed integer,
  srf_estpopulationrisk text COLLATE public.arms_ci,
  srf_estoutbreakradius text COLLATE public.arms_ci,
  srf_diagnosisnature text COLLATE public.arms_ci,
  srf_laboratoryname text COLLATE public.arms_ci,
  srf_historycomments text COLLATE public.arms_ci,
  srf_controlmeasures text COLLATE public.arms_ci,
  srf_officialname text COLLATE public.arms_ci,
  srf_officialtel text COLLATE public.arms_ci,
  srf_officialfax text COLLATE public.arms_ci,
  srf_officialemail text COLLATE public.arms_ci,
  srf_officialcell text COLLATE public.arms_ci,
  PRIMARY KEY (srf_id)
);

-- NAHDIS_FSA.GetProvince, as it was in SQL Server and MySQL. MySQL's LIMIT 1 had
-- no ORDER BY; the lowest REG_ID is what InnoDB returned, and is now stated.
CREATE OR REPLACE FUNCTION nahdis_fsa.getprovince(regionid integer) RETURNS varchar
LANGUAGE sql STABLE AS $$
  SELECT r.reg_name FROM nahdis_fsa.regions r
   WHERE r.reg_type = 'Province'
     AND (r.reg_parentid = regionid OR r.reg_id = regionid
          OR r.reg_id = (SELECT r2.reg_parentid FROM nahdis_fsa.regions r2
                          WHERE r2.reg_id = regionid AND r2.reg_type = 'Town'))
   ORDER BY r.reg_id
   LIMIT 1
$$;
