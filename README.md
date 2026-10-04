# Shop loto — Backend

Sèvè **Node.js + Express** pou aplikasyon Android **Shop loto**. Li jere:
- Rezilta lotri **New York** (API Socrata ofisyèl) ak **Florida** (scraping sit ofisyèl)
- Ote/enskripsyon pa **nimewo telefòn**
- Peman **Natcash** (screenshot base64) + validation admin
- **Panel admin** (estatistik, demann peman, aktive/refize VIP)

## Deplwaye sou Railway

1. Ale sou [railway.app](https://railway.app) → "New Project" → "Deploy from GitHub repo".
2. Chwazi repo **Shop-loto-backend** sa a.
3. Railway ap detekte `railway.json` epi `package.json` pou kòmanse ak `npm start`.
4. Fikse varyab anviwònman yo (wè anba).
5. Kopye **URL piblik** la (ex: `https://shop-loto-production.up.railway.app`).

## Varyab anviwònman (.env)

| Non | Deskripsyon | Egzanp |
|-----|-------------|--------|
| `PORT` | Pò sèvè a (Railway bay li otomatik) | `8080` |
| `ADMIN_PHONES` | Lis nimewo admin, separe pa vigil | `50955394345` |
| `JWT_SECRET` | Kle sekrè pou jenere token | `chanje-sa-a-yon-valè-sekrè` |
| `DATABASE_PATH` | Chemen baz done | `./data/data.json` |

**Enpòtan**: `JWT_SECRET` *dwe* yon valè sekrè lè w deplwaye an pwodiksyon.

## Endpoints prensipal

| Metod | Endpoint | Deskripsyon |
|-------|----------|-------------|
| POST | `/api/auth/register` | Enskri (phone, first_name, last_name) |
| POST | `/api/auth/login` | Konekte pa phone |
| GET | `/api/results/ny` | Rezilta New York |
| GET | `/api/results/fl` | Rezilta Florida |
| POST | `/api/payments/submit` | Soumèt peman (screenshot base64) |
| GET | `/api/admin/payments` | Lis demann peman (admin) |
| POST | `/api/admin/payments/:id/approve` | Valide peman (admin) |
| POST | `/api/admin/payments/:id/reject` | Refize peman (admin) |
| GET | `/api/admin/dashboard` | Estatistik panel (admin) |

## Nimewo kont admin

Lè w konekte ak nimewo ki nan `ADMIN_PHONES`, kont admin la kreye otomatikman. Apre sa w ap wè tab "Admin" nan aplikasyon an.
