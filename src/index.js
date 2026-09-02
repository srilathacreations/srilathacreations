export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // HELPERS
    // =====================================================

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      });

    const getAdminToken = () => {
      const auth = request.headers.get("Authorization") || "";

      if (auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
      }

      return request.headers.get("X-Admin-Token") || "";
    };

    const isAdmin = () => {
      if (!env.ADMIN_TOKEN) return false;
      return getAdminToken() === env.ADMIN_TOKEN;
    };

    const requireAdmin = () => {
      if (!env.ADMIN_TOKEN) {
        return json(
          {
            success: false,
            error: "ADMIN_TOKEN is not configured"
          },
          503
        );
      }

      if (!isAdmin()) {
        return json(
          {
            success: false,
            error: "Unauthorized"
          },
          401
        );
      }

      return null;
    };

    const cleanPhone = value => {
      let digits = String(value || "").replace(/\D/g, "");

      if (digits.length === 12 && digits.startsWith("91")) {
        digits = digits.slice(2);
      }

      return digits;
    };

    const nullableText = value => {
      const v = String(value ?? "").trim();
      return v ? v : null;
    };

    const normalizeCouponCode = value =>
      String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

    const calculateCouponDiscount = (
      coupon,
      subtotal
    ) => {
      if (!coupon) return 0;

      let discount = 0;

      const type =
        String(
          coupon.discount_type || ""
        ).toLowerCase();

      const value =
        Number(
          coupon.discount_value || 0
        );

      if (
        type === "percent" ||
        type === "percentage"
      ) {
        discount =
          subtotal * (value / 100);
      } else if (
        type === "flat" ||
        type === "fixed"
      ) {
        discount = value;
      }

      if (
        coupon.max_discount !== null &&
        coupon.max_discount !== undefined &&
        Number(coupon.max_discount) > 0
      ) {
        discount =
          Math.min(
            discount,
            Number(
              coupon.max_discount
            )
          );
      }

      discount =
        Math.max(
          0,
          Math.min(
            discount,
            subtotal
          )
        );

      return Math.round(
        discount * 100
      ) / 100;
    };

    const getValidCoupon =
      async (
        code,
        subtotal
      ) => {

        const normalized =
          normalizeCouponCode(code);

        if (!normalized) {
          return {
            coupon: null,
            discount: 0
          };
        }

        const coupon =
          await env.DB
            .prepare(
              `SELECT *
               FROM coupons
               WHERE UPPER(TRIM(code)) = UPPER(TRIM(?))
               AND is_active = 1
               LIMIT 1`
            )
            .bind(normalized)
            .first();

        if (!coupon) {
          throw new Error(
            "Invalid or inactive coupon code"
          );
        }

        const now =
          new Date();

        if (coupon.start_at) {
          const start =
            new Date(
              coupon.start_at
            );

          if (
            !Number.isNaN(
              start.getTime()
            ) &&
            now < start
          ) {
            throw new Error(
              "This coupon is not active yet"
            );
          }
        }

        if (coupon.end_at) {
          const end =
            new Date(
              coupon.end_at
            );

          if (
            !Number.isNaN(
              end.getTime()
            ) &&
            now > end
          ) {
            throw new Error(
              "This coupon has expired"
            );
          }
        }

        const minOrder =
          Number(
            coupon.min_order_amount || 0
          );

        if (
          subtotal < minOrder
        ) {
          throw new Error(
            `Minimum order amount for this coupon is ₹${minOrder.toLocaleString("en-IN")}`
          );
        }

        if (
          coupon.usage_limit !== null &&
          coupon.usage_limit !== undefined &&
          Number(
            coupon.usage_limit
          ) > 0 &&
          Number(
            coupon.used_count || 0
          ) >=
          Number(
            coupon.usage_limit
          )
        ) {
          throw new Error(
            "This coupon usage limit has been reached"
          );
        }

        const discount =
          calculateCouponDiscount(
            coupon,
            subtotal
          );

        if (discount <= 0) {
          throw new Error(
            "This coupon does not provide a valid discount"
          );
        }

        return {
          coupon,
          discount
        };
      };

    // =====================================================
    // API TEST
    // =====================================================

    if (
      url.pathname === "/api/test" &&
      request.method === "GET"
    ) {
      try {
        const result =
          await env.DB
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            .all();

        return json({
          success: true,
          message:
            "Srilatha Creations backend is working",
          database:
            "Connected",
          tables:
            result.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // PUBLIC PRODUCTS
    // =====================================================

    if (
      url.pathname ===
        "/api/products" &&
      request.method === "GET"
    ) {
      try {
        const products =
          await env.DB
            .prepare(
              `SELECT *
               FROM products
               WHERE is_active = 1
               ORDER BY id DESC`
            )
            .all();

        return json(
          products.results
        );
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // PUBLIC ACTIVE OFFERS
    // =====================================================

    if (
      url.pathname ===
        "/api/offers" &&
      request.method === "GET"
    ) {
      try {
        const offers =
          await env.DB
            .prepare(
              `SELECT *
               FROM offers
               WHERE is_active = 1
               AND
               (
                 start_at IS NULL
                 OR
                 datetime(start_at)
                 <= CURRENT_TIMESTAMP
               )
               AND
               (
                 end_at IS NULL
                 OR
                 datetime(end_at)
                 >= CURRENT_TIMESTAMP
               )
               ORDER BY id DESC`
            )
            .all();

        return json({
          success: true,
          offers:
            offers.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // PUBLIC COUPON VALIDATION
    // Secure: subtotal is recalculated using DB product prices.
    // POST:
    // {
    //   code:"WELCOME10",
    //   items:[{id,qty}]
    // }
    // =====================================================

    if (
      url.pathname ===
        "/api/coupons/validate" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const code =
          normalizeCouponCode(
            body.code
          );

        const items =
          Array.isArray(
            body.items
          )
            ? body.items
            : [];

        if (!code) {
          return json(
            {
              success: false,
              error:
                "Coupon code is required"
            },
            400
          );
        }

        if (!items.length) {
          return json(
            {
              success: false,
              error:
                "Cart is empty"
            },
            400
          );
        }

        let subtotal = 0;

        for (
          const item of items
        ) {
          const productId =
            Number(
              item.id ||
              item.product_id
            );

          const quantity =
            Number(
              item.qty ||
              item.quantity ||
              0
            );

          if (
            !Number.isInteger(
              productId
            ) ||
            productId <= 0 ||
            !Number.isInteger(
              quantity
            ) ||
            quantity <= 0
          ) {
            return json(
              {
                success: false,
                error:
                  "Invalid cart item"
              },
              400
            );
          }

          const product =
            await env.DB
              .prepare(
                `SELECT
                  id,
                  price,
                  sale_price,
                  stock,
                  is_active
                 FROM products
                 WHERE id = ?`
              )
              .bind(productId)
              .first();

          if (
            !product ||
            Number(
              product.is_active
            ) !== 1
          ) {
            return json(
              {
                success: false,
                error:
                  "One of the selected products is unavailable"
              },
              400
            );
          }

          const regularPrice =
            Number(
              product.price || 0
            );

          const salePrice =
            product.sale_price !==
              null &&
            product.sale_price !==
              undefined &&
            Number(
              product.sale_price
            ) > 0
              ? Number(
                  product.sale_price
                )
              : null;

          const price =
            salePrice !== null
              ? salePrice
              : regularPrice;

          subtotal +=
            price * quantity;
        }

        const result =
          await getValidCoupon(
            code,
            subtotal
          );

        const total =
          Math.max(
            0,
            subtotal -
            result.discount
          );

        return json({
          success: true,

          coupon: {
            code:
              normalizeCouponCode(
                result.coupon.code
              ),

            discount_type:
              result.coupon
                .discount_type,

            discount_value:
              Number(
                result.coupon
                  .discount_value
              )
          },

          subtotal,
          discount_amount:
            result.discount,
          total_amount:
            total
        });
      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to apply coupon"
          },
          400
        );
      }
    }

    // =====================================================
    // CREATE ORDER - COD + COUPONS
    // =====================================================

    if (
      url.pathname ===
        "/api/orders" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const customer =
          body.customer || {};

        const customerName =
          String(
            customer.name ||
            body.customer_name ||
            ""
          ).trim();

        const phone =
          cleanPhone(
            customer.phone ||
            body.phone ||
            ""
          );

        const email =
          String(
            customer.email ||
            body.email ||
            ""
          ).trim();

        const address =
          String(
            customer.address ||
            body.address ||
            ""
          ).trim();

        const city =
          String(
            customer.city ||
            body.city ||
            ""
          ).trim();

        const state =
          String(
            customer.state ||
            body.state ||
            ""
          ).trim();

        const pincode =
          String(
            customer.pincode ||
            body.pincode ||
            ""
          )
            .replace(
              /\D/g,
              ""
            );

        const couponCode =
          normalizeCouponCode(
            body.coupon_code ||
            body.coupon ||
            ""
          );

        const items =
          Array.isArray(
            body.items
          )
            ? body.items
            : [];

        // -------------------------
        // VALIDATION
        // -------------------------

        if (!customerName) {
          return json(
            {
              success: false,
              error:
                "Customer name is required"
            },
            400
          );
        }

        if (
          !/^[0-9]{10}$/.test(
            phone
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Enter a valid 10 digit mobile number"
            },
            400
          );
        }

        if (!address) {
          return json(
            {
              success: false,
              error:
                "Delivery address is required"
            },
            400
          );
        }

        if (
          pincode &&
          !/^[0-9]{6}$/.test(
            pincode
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Enter a valid 6 digit PIN code"
            },
            400
          );
        }

        if (!items.length) {
          return json(
            {
              success: false,
              error:
                "Cart is empty"
            },
            400
          );
        }

        // -------------------------
        // VERIFY PRODUCTS
        // -------------------------

        const verifiedItems =
          [];

        let subtotal = 0;

        for (
          const item of items
        ) {
          const productId =
            Number(
              item.id ||
              item.product_id
            );

          const quantity =
            Number(
              item.qty ||
              item.quantity ||
              0
            );

          if (
            !Number.isInteger(
              productId
            ) ||
            productId <= 0 ||
            !Number.isInteger(
              quantity
            ) ||
            quantity <= 0
          ) {
            return json(
              {
                success: false,
                error:
                  "Invalid cart item"
              },
              400
            );
          }

          const product =
            await env.DB
              .prepare(
                `SELECT
                  id,
                  name,
                  price,
                  sale_price,
                  stock,
                  is_active
                 FROM products
                 WHERE id = ?`
              )
              .bind(
                productId
              )
              .first();

          if (
            !product ||
            Number(
              product.is_active
            ) !== 1
          ) {
            return json(
              {
                success: false,
                error:
                  "One of the selected products is unavailable"
              },
              400
            );
          }

          if (
            Number(
              product.stock
            ) < quantity
          ) {
            return json(
              {
                success: false,
                error:
                  `${product.name} has only ` +
                  `${product.stock} item(s) available`
              },
              400
            );
          }

          const regularPrice =
            Number(
              product.price || 0
            );

          const salePrice =
            product.sale_price !==
              null &&
            product.sale_price !==
              undefined &&
            Number(
              product.sale_price
            ) > 0
              ? Number(
                  product.sale_price
                )
              : null;

          const finalPrice =
            salePrice !== null
              ? salePrice
              : regularPrice;

          const itemTotal =
            finalPrice *
            quantity;

          subtotal +=
            itemTotal;

          verifiedItems.push({
            product_id:
              Number(product.id),

            product_name:
              product.name,

            quantity,

            price:
              finalPrice,

            total:
              itemTotal
          });
        }

        // -------------------------
        // COUPON
        // -------------------------

        let coupon = null;
        let discountAmount = 0;

        if (couponCode) {
          const couponResult =
            await getValidCoupon(
              couponCode,
              subtotal
            );

          coupon =
            couponResult.coupon;

          discountAmount =
            couponResult.discount;
        }

        // -------------------------
        // TOTALS
        // -------------------------

        const deliveryCharge =
          0;

        const totalAmount =
          Math.max(
            0,
            subtotal -
            discountAmount +
            deliveryCharge
          );

        // -------------------------
        // CUSTOMER
        // -------------------------

        const existingCustomer =
          await env.DB
            .prepare(
              `SELECT id
               FROM customers
               WHERE phone = ?
               ORDER BY id DESC
               LIMIT 1`
            )
            .bind(phone)
            .first();

        let customerId;

        if (
          existingCustomer
        ) {
          customerId =
            Number(
              existingCustomer.id
            );

          await env.DB
            .prepare(
              `UPDATE customers
               SET
                 name = ?,
                 email = ?,
                 address = ?,
                 city = ?,
                 state = ?,
                 pincode = ?
               WHERE id = ?`
            )
            .bind(
              customerName,
              email || null,
              address,
              city || null,
              state || null,
              pincode || null,
              customerId
            )
            .run();
        } else {
          const createdCustomer =
            await env.DB
              .prepare(
                `INSERT INTO customers
                (
                  name,
                  phone,
                  email,
                  address,
                  city,
                  state,
                  pincode
                )
                VALUES
                (?, ?, ?, ?, ?, ?, ?)
                RETURNING id`
              )
              .bind(
                customerName,
                phone,
                email || null,
                address,
                city || null,
                state || null,
                pincode || null
              )
              .first();

          customerId =
            Number(
              createdCustomer.id
            );
        }

        // -------------------------
        // ORDER NUMBER
        // -------------------------

        const now =
          new Date();

        const datePart =
          now
            .getUTCFullYear()
            .toString() +
          String(
            now.getUTCMonth() + 1
          ).padStart(2, "0") +
          String(
            now.getUTCDate()
          ).padStart(2, "0");

        const randomPart =
          Math.floor(
            100000 +
            Math.random() *
            900000
          );

        const orderNumber =
          `SC-${datePart}-${randomPart}`;

        // -------------------------
        // CREATE ORDER
        // -------------------------

        const createdOrder =
          await env.DB
            .prepare(
              `INSERT INTO orders
              (
                order_number,
                customer_id,
                customer_name,
                phone,
                email,
                address,
                city,
                state,
                pincode,
                subtotal,
                discount_amount,
                coupon_code,
                delivery_charge,
                total_amount,
                payment_method,
                payment_status,
                payment_id,
                order_status
              )
              VALUES
              (
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?
              )
              RETURNING id`
            )
            .bind(
              orderNumber,
              customerId,
              customerName,
              phone,
              email || null,
              address,
              city || null,
              state || null,
              pincode || null,
              subtotal,
              discountAmount,
              couponCode ||
                null,
              deliveryCharge,
              totalAmount,
              "COD",
              "pending",
              null,
              "pending"
            )
            .first();

        const orderId =
          Number(
            createdOrder.id
          );

        // -------------------------
        // ORDER ITEMS + STOCK
        // -------------------------

        for (
          const item of
          verifiedItems
        ) {
          await env.DB
            .prepare(
              `INSERT INTO order_items
              (
                order_id,
                product_id,
                product_name,
                quantity,
                price,
                total
              )
              VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              orderId,
              item.product_id,
              item.product_name,
              item.quantity,
              item.price,
              item.total
            )
            .run();

          const stockUpdate =
            await env.DB
              .prepare(
                `UPDATE products
                 SET stock =
                   stock - ?
                 WHERE id = ?
                 AND stock >= ?`
              )
              .bind(
                item.quantity,
                item.product_id,
                item.quantity
              )
              .run();

          if (
            Number(
              stockUpdate
                .meta?.changes ||
              0
            ) !== 1
          ) {
            throw new Error(
              `Unable to update stock for ${item.product_name}`
            );
          }
        }

        // -------------------------
        // COUPON USAGE
        // -------------------------

        if (coupon) {
          await env.DB
            .prepare(
              `UPDATE coupons
               SET used_count =
                 used_count + 1
               WHERE id = ?`
            )
            .bind(
              coupon.id
            )
            .run();
        }

        return json(
          {
            success: true,

            message:
              "Order placed successfully",

            order: {
              id:
                orderId,

              order_number:
                orderNumber,

              customer_name:
                customerName,

              phone,

              subtotal,

              coupon_code:
                couponCode ||
                null,

              discount_amount:
                discountAmount,

              delivery_charge:
                deliveryCharge,

              total_amount:
                totalAmount,

              payment_method:
                "COD",

              payment_status:
                "pending",

              order_status:
                "pending"
            },

            order_id:
              orderId,

            order_number:
              orderNumber,

            total:
              totalAmount
          },
          201
        );

      } catch (error) {
        console.error(
          "Order API error:",
          error
        );

        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to place order"
          },
          500
        );
      }
    }

    // =====================================================
    // PUBLIC ORDER LOOKUP / TRACKING
    // =====================================================

    if (
      url.pathname.startsWith(
        "/api/orders/"
      ) &&
      request.method === "GET"
    ) {
      try {
        const orderNumber =
          decodeURIComponent(
            url.pathname.replace(
              "/api/orders/",
              ""
            )
          ).trim();

        const phone =
          cleanPhone(
            url.searchParams.get(
              "phone"
            ) || ""
          );

        if (!orderNumber) {
          return json(
            {
              success: false,
              error:
                "Order number is required"
            },
            400
          );
        }

        if (
          !/^[0-9]{10}$/.test(
            phone
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Enter the 10 digit mobile number used for the order"
            },
            400
          );
        }

        const order =
          await env.DB
            .prepare(
              `SELECT
                order_number,
                customer_name,
                phone,
                subtotal,
                coupon_code,
                discount_amount,
                delivery_charge,
                total_amount,
                payment_method,
                payment_status,
                order_status,
                courier_name,
                tracking_id,
                tracking_url,
                shipped_at,
                created_at
               FROM orders
               WHERE order_number = ?
               AND phone = ?`
            )
            .bind(
              orderNumber,
              phone
            )
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error:
                "Order not found. Check the order number and mobile number."
            },
            404
          );
        }

        return json({
          success: true,
          order
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // CUSTOMER AUTH HELPERS
    // =====================================================

    const sha256 = async value => {
      const data = new TextEncoder().encode(
        String(value || "")
      );

      const hash = await crypto.subtle.digest(
        "SHA-256",
        data
      );

      return Array.from(
        new Uint8Array(hash)
      )
        .map(byte =>
          byte.toString(16).padStart(2, "0")
        )
        .join("");
    };

    const createSecureToken = () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);

      return Array.from(bytes)
        .map(byte =>
          byte.toString(16).padStart(2, "0")
        )
        .join("");
    };

    const getCustomerToken = () => {
      const auth =
        request.headers.get("Authorization") || "";

      if (auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
      }

      return "";
    };

    const getAuthenticatedCustomer = async () => {
      const token = getCustomerToken();

      if (!token) {
        return null;
      }

      const tokenHash = await sha256(token);

      const session = await env.DB
        .prepare(
          `SELECT
             cs.id AS session_id,
             cs.customer_id,
             c.name,
             c.phone,
             c.email,
             c.address,
             c.city,
             c.state,
             c.pincode
           FROM customer_sessions cs
           JOIN customers c
             ON c.id = cs.customer_id
           WHERE cs.token_hash = ?
             AND cs.revoked_at IS NULL
             AND datetime(cs.expires_at) > CURRENT_TIMESTAMP
           LIMIT 1`
        )
        .bind(tokenHash)
        .first();

      if (!session) {
        return null;
      }

      await env.DB
        .prepare(
          `UPDATE customer_sessions
           SET last_used_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(session.session_id)
        .run();

      return session;
    };
        // =====================================================
    // CUSTOMER ACCOUNT - CURRENT USER
    // =====================================================

    if (
      url.pathname === "/api/customer/me" &&
      request.method === "GET"
    ) {
      try {
        const customer =
          await getAuthenticatedCustomer();

        if (!customer) {
          return json(
            {
              success: false,
              error: "Customer login required"
            },
            401
          );
        }

        return json({
          success: true,
          customer: {
            id: customer.customer_id,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            city: customer.city,
            state: customer.state,
            pincode: customer.pincode
          }
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to load customer account"
          },
          500
        );
      }
    }

    // =====================================================
    // CUSTOMER ACCOUNT - LOGOUT
    // =====================================================

    if (
      url.pathname === "/api/customer/logout" &&
      request.method === "POST"
    ) {
      try {
        const token = getCustomerToken();

        if (!token) {
          return json({
            success: true,
            message: "Logged out"
          });
        }

        const tokenHash =
          await sha256(token);

        await env.DB
          .prepare(
            `UPDATE customer_sessions
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE token_hash = ?
             AND revoked_at IS NULL`
          )
          .bind(tokenHash)
          .run();

        return json({
          success: true,
          message: "Logged out successfully"
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to logout"
          },
          500
        );
      }
    }
    // ==================================================
// CUSTOMER EMAIL OTP - REQUEST
// ==================================================

if (
  url.pathname === "/api/customer/otp/request" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();

    const email = String(
      body.email || ""
    )
      .trim()
      .toLowerCase();

    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return json(
        {
          success: false,
          error: "Enter a valid email address"
        },
        400
      );
    }

    if (!env.RESEND_API_KEY) {
      return json(
        {
          success: false,
          error: "Email service is not configured"
        },
        500
      );
    }

    // Only customers already present in our store
    // can request a login OTP.
    const customer = await env.DB
      .prepare(
        `SELECT
          id,
          name,
          phone,
          email
        FROM customers
        WHERE LOWER(email) = ?
        ORDER BY id DESC
        LIMIT 1`
      )
      .bind(email)
      .first();

    // Return a generic response if no account exists.
    // This avoids exposing registered customer emails.
    if (!customer) {
      return json({
        success: true,
        message:
          "If this email is registered, an OTP will be sent."
      });
    }

    // Prevent repeated OTP requests within 60 seconds.
    const recentOtp = await env.DB
      .prepare(
        `SELECT id
        FROM customer_otp
        WHERE email = ?
          AND created_at >= datetime('now', '-60 seconds')
        ORDER BY id DESC
        LIMIT 1`
      )
      .bind(email)
      .first();

    if (recentOtp) {
      return json(
        {
          success: false,
          error:
            "Please wait 60 seconds before requesting another OTP"
        },
        429
      );
    }

    // Expire previous unused OTPs for this email.
    await env.DB
      .prepare(
        `UPDATE customer_otp
        SET expires_at = CURRENT_TIMESTAMP
        WHERE email = ?
          AND verified_at IS NULL`
      )
      .bind(email)
      .run();

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    const otp = String(
      100000 + (random[0] % 900000)
    );

    const otpHash = await sha256(otp);

    await env.DB
      .prepare(
        `INSERT INTO customer_otp (
          phone,
          email,
          otp_hash,
          expires_at,
          attempts
        )
        VALUES (
          ?,
          ?,
          ?,
          datetime('now', '+10 minutes'),
          0
        )`
      )
      .bind(
        String(customer.phone || ""),
        email,
        otpHash
      )
      .run();

    const resendResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from:
            "Srilatha Creations <otp@auth.srilathacreations.com>",
          to: [email],
          subject:
            "Your Srilatha Creations Login OTP",
          text:
            `Your Srilatha Creations login OTP is ${otp}. ` +
            `This OTP is valid for 10 minutes. ` +
            `Do not share this OTP with anyone.`,
          html: `
            <div style="
              font-family:Arial,sans-serif;
              max-width:520px;
              margin:auto;
              padding:28px;
              border:1px solid #eee;
              border-radius:14px;
            ">
              <h2 style="margin-top:0;">
                Srilatha Creations
              </h2>

              <p>
                Hello ${String(
                  customer.name || "Customer"
                )},
              </p>

              <p>
                Use the following OTP to securely
                sign in to your account:
              </p>

              <div style="
                font-size:34px;
                font-weight:700;
                letter-spacing:8px;
                padding:18px 0;
              ">
                ${otp}
              </div>

              <p>
                This OTP is valid for
                <strong>10 minutes</strong>.
              </p>

              <p style="
                font-size:13px;
                color:#666;
              ">
                Do not share this OTP with anyone.
                If you did not request this login,
                you can safely ignore this email.
              </p>
            </div>
          `
        })
      }
    );

    if (!resendResponse.ok) {
      const resendError =
        await resendResponse.text();

      console.error(
        "Resend OTP error:",
        resendError
      );

      return json(
        {
          success: false,
          error: "Unable to send OTP"
        },
        502
      );
    }

    return json({
      success: true,
      message: "OTP sent to your email",
      expires_in: 600
    });

  } catch (error) {
    console.error(
      "Customer OTP request error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Unable to send OTP"
      },
      500
    );
  }
}


// ==================================================
// CUSTOMER EMAIL OTP - VERIFY
// ==================================================

if (
  url.pathname === "/api/customer/otp/verify" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();

    const email = String(
      body.email || ""
    )
      .trim()
      .toLowerCase();

    const otp = String(
      body.otp || ""
    ).trim();

    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return json(
        {
          success: false,
          error: "Enter a valid email address"
        },
        400
      );
    }

    if (!/^\d{6}$/.test(otp)) {
      return json(
        {
          success: false,
          error: "Enter the 6-digit OTP"
        },
        400
      );
    }

    const otpRecord = await env.DB
      .prepare(
        `SELECT
          id,
          email,
          phone,
          otp_hash,
          attempts,
          expires_at,
          verified_at
        FROM customer_otp
        WHERE email = ?
          AND verified_at IS NULL
        ORDER BY id DESC
        LIMIT 1`
      )
      .bind(email)
      .first();

    if (!otpRecord) {
      return json(
        {
          success: false,
          error:
            "Invalid or expired OTP"
        },
        400
      );
    }

    if (
      Number(otpRecord.attempts || 0) >= 5
    ) {
      return json(
        {
          success: false,
          error:
            "Too many incorrect attempts. Request a new OTP."
        },
        429
      );
    }

    const expiryCheck = await env.DB
      .prepare(
        `SELECT
          CASE
            WHEN datetime(?) > CURRENT_TIMESTAMP
            THEN 1
            ELSE 0
          END AS valid`
      )
      .bind(otpRecord.expires_at)
      .first();

    if (!expiryCheck?.valid) {
      return json(
        {
          success: false,
          error:
            "OTP expired. Request a new OTP."
        },
        400
      );
    }

    const otpHash = await sha256(otp);

    if (otpHash !== otpRecord.otp_hash) {
      await env.DB
        .prepare(
          `UPDATE customer_otp
          SET attempts = attempts + 1
          WHERE id = ?`
        )
        .bind(otpRecord.id)
        .run();

      return json(
        {
          success: false,
          error: "Incorrect OTP"
        },
        400
      );
    }

    const customer = await env.DB
      .prepare(
        `SELECT
          id,
          name,
          phone,
          email,
          address,
          city,
          state,
          pincode
        FROM customers
        WHERE LOWER(email) = ?
        ORDER BY id DESC
        LIMIT 1`
      )
      .bind(email)
      .first();

    if (!customer) {
      return json(
        {
          success: false,
          error:
            "Customer account not found"
        },
        404
      );
    }

    await env.DB
      .prepare(
        `UPDATE customer_otp
        SET verified_at = CURRENT_TIMESTAMP
        WHERE id = ?`
      )
      .bind(otpRecord.id)
      .run();

    await env.DB
      .prepare(
        `UPDATE customers
        SET
          is_verified = 1,
          last_login_at = CURRENT_TIMESTAMP
        WHERE id = ?`
      )
      .bind(customer.id)
      .run();

    // Revoke any expired sessions first.
    await env.DB
      .prepare(
        `UPDATE customer_sessions
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE customer_id = ?
          AND revoked_at IS NULL
          AND expires_at <= CURRENT_TIMESTAMP`
      )
      .bind(customer.id)
      .run();

    const tokenBytes =
      new Uint8Array(32);

    crypto.getRandomValues(tokenBytes);

    const token = Array.from(tokenBytes)
      .map(byte =>
        byte
          .toString(16)
          .padStart(2, "0")
      )
      .join("");

    const tokenHash =
      await sha256(token);

    await env.DB
      .prepare(
        `INSERT INTO customer_sessions (
          customer_id,
          token_hash,
          expires_at
        )
        VALUES (
          ?,
          ?,
          datetime('now', '+30 days')
        )`
      )
      .bind(
        customer.id,
        tokenHash
      )
      .run();

    return json({
      success: true,
      message: "Login successful",
      token,
      expires_in: 2592000,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        city: customer.city,
        state: customer.state,
        pincode: customer.pincode
      }
    });

  } catch (error) {
    console.error(
      "Customer OTP verify error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Unable to verify OTP"
      },
      500
    );
  }
}
    // =====================================================
    // ADMIN AUTH
    // =====================================================

    if (
      (
        url.pathname ===
          "/api/admin/check" ||
        url.pathname ===
          "/api/admin/session"
      ) &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      return json({
        success: true,
        message:
          "Admin authenticated"
      });
    }

    // =====================================================
    // ADMIN ORDERS - LIST
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/orders" &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const orders =
          await env.DB
            .prepare(
              `SELECT
                id,
                order_number,
                customer_name,
                phone,
                email,
                address,
                city,
                state,
                pincode,
                subtotal,
                coupon_code,
                discount_amount,
                delivery_charge,
                total_amount,
                payment_method,
                payment_status,
                payment_id,
                order_status,
                courier_name,
                tracking_id,
                tracking_url,
                shipped_at,
                created_at
               FROM orders
               ORDER BY id DESC
               LIMIT 500`
            )
            .all();

        return json({
          success: true,
          orders:
            orders.results
        });
      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN ORDER DETAIL
    // =====================================================

    const adminOrderMatch =
      url.pathname.match(
        /^\/api\/admin\/orders\/(\d+)$/
      );

    if (
      adminOrderMatch &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const orderId =
          Number(
            adminOrderMatch[1]
          );

        const order =
          await env.DB
            .prepare(
              `SELECT *
               FROM orders
               WHERE id = ?`
            )
            .bind(
              orderId
            )
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error:
                "Order not found"
            },
            404
          );
        }

        const items =
          await env.DB
            .prepare(
              `SELECT *
               FROM order_items
               WHERE order_id = ?
               ORDER BY id ASC`
            )
            .bind(
              orderId
            )
            .all();

        return json({
          success: true,
          order,
          items:
            items.results
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN UPDATE ORDER STATUS
    // =====================================================

    const statusMatch =
      url.pathname.match(
        /^\/api\/admin\/orders\/(\d+)\/status$/
      );

    if (
      statusMatch &&
      (
        request.method ===
          "PUT" ||
        request.method ===
          "PATCH"
      )
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const orderId =
          Number(
            statusMatch[1]
          );

        const body =
          await request.json();

        const newStatus =
          String(
            body.order_status ||
            body.status ||
            ""
          )
            .trim()
            .toLowerCase();

        const allowedStatuses = [
          "pending",
          "confirmed",
          "processing",
          "packed",
          "shipped",
          "delivered",
          "cancelled"
        ];

        if (
          !allowedStatuses.includes(
            newStatus
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid order status"
            },
            400
          );
        }

        const order =
          await env.DB
            .prepare(
              `SELECT
                id,
                order_status
               FROM orders
               WHERE id = ?`
            )
            .bind(
              orderId
            )
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error:
                "Order not found"
            },
            404
          );
        }

        const oldStatus =
          String(
            order.order_status ||
            "pending"
          ).toLowerCase();

        if (
          oldStatus ===
            "cancelled" &&
          newStatus !==
            "cancelled"
        ) {
          return json(
            {
              success: false,
              error:
                "Cancelled order cannot be reopened automatically"
            },
            400
          );
        }

        // Restore product stock
        if (
          oldStatus !==
            "cancelled" &&
          newStatus ===
            "cancelled"
        ) {
          const items =
            await env.DB
              .prepare(
                `SELECT
                  product_id,
                  quantity
                 FROM order_items
                 WHERE order_id = ?`
              )
              .bind(
                orderId
              )
              .all();

          for (
            const item of
            items.results
          ) {
            if (
              item.product_id
            ) {
              await env.DB
                .prepare(
                  `UPDATE products
                   SET stock =
                     stock + ?
                   WHERE id = ?`
                )
                .bind(
                  Number(
                    item.quantity ||
                    0
                  ),
                  Number(
                    item.product_id
                  )
                )
                .run();
            }
          }
        }

        if (
          newStatus ===
            "shipped"
        ) {
          await env.DB
            .prepare(
              `UPDATE orders
               SET
                 order_status = ?,
                 shipped_at =
                   COALESCE(
                     shipped_at,
                     CURRENT_TIMESTAMP
                   )
               WHERE id = ?`
            )
            .bind(
              newStatus,
              orderId
            )
            .run();
        } else {
          await env.DB
            .prepare(
              `UPDATE orders
               SET order_status = ?
               WHERE id = ?`
            )
            .bind(
              newStatus,
              orderId
            )
            .run();
        }

        return json({
          success: true,
          message:
            "Order status updated",
          order_id:
            orderId,
          order_status:
            newStatus
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN SHIPPING / TRACKING UPDATE
    // =====================================================

    const shippingMatch =
      url.pathname.match(
        /^\/api\/admin\/orders\/(\d+)\/shipping$/
      );

    if (
      shippingMatch &&
      (
        request.method ===
          "PUT" ||
        request.method ===
          "PATCH"
      )
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const orderId =
          Number(
            shippingMatch[1]
          );

        const body =
          await request.json();

        const courierName =
          nullableText(
            body.courier_name
          );

        const trackingId =
          nullableText(
            body.tracking_id
          );

        const trackingUrl =
          nullableText(
            body.tracking_url
          );

        if (
          trackingUrl &&
          !/^https?:\/\//i.test(
            trackingUrl
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Tracking link must start with http:// or https://"
            },
            400
          );
        }

        const existing =
          await env.DB
            .prepare(
              `SELECT id
               FROM orders
               WHERE id = ?`
            )
            .bind(
              orderId
            )
            .first();

        if (!existing) {
          return json(
            {
              success: false,
              error:
                "Order not found"
            },
            404
          );
        }

        const order =
          await env.DB
            .prepare(
              `UPDATE orders
               SET
                 courier_name = ?,
                 tracking_id = ?,
                 tracking_url = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              courierName,
              trackingId,
              trackingUrl,
              orderId
            )
            .first();

        return json({
          success: true,
          message:
            "Shipping details updated",
          order
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCTS - LIST
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/products" &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const products =
          await env.DB
            .prepare(
              `SELECT *
               FROM products
               ORDER BY id DESC`
            )
            .all();

        return json({
          success: true,
          products:
            products.results
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCTS - CREATE
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/products" &&
      request.method === "POST"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const body =
          await request.json();

        const name =
          String(
            body.name || ""
          ).trim();

        const category =
          String(
            body.category || ""
          ).trim();

        const description =
          nullableText(
            body.description
          );

        const price =
          Number(
            body.price
          );

        const salePrice =
          body.sale_price ===
            "" ||
          body.sale_price ===
            null ||
          body.sale_price ===
            undefined
            ? null
            : Number(
                body.sale_price
              );

        const imageUrl =
          nullableText(
            body.image_url
          );

        const stock =
          Number(
            body.stock ?? 0
          );

        const isActive =
          body.is_active ===
            false ||
          Number(
            body.is_active
          ) === 0
            ? 0
            : 1;

        if (!name) {
          return json(
            {
              success: false,
              error:
                "Product name is required"
            },
            400
          );
        }

        if (!category) {
          return json(
            {
              success: false,
              error:
                "Category is required"
            },
            400
          );
        }

        if (
          !Number.isFinite(
            price
          ) ||
          price < 0
        ) {
          return json(
            {
              success: false,
              error:
                "Valid product price is required"
            },
            400
          );
        }

        if (
          salePrice !== null &&
          (
            !Number.isFinite(
              salePrice
            ) ||
            salePrice < 0
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid sale price"
            },
            400
          );
        }

        if (
          !Number.isInteger(
            stock
          ) ||
          stock < 0
        ) {
          return json(
            {
              success: false,
              error:
                "Stock must be 0 or more"
            },
            400
          );
        }

        const product =
          await env.DB
            .prepare(
              `INSERT INTO products
              (
                name,
                category,
                description,
                price,
                sale_price,
                image_url,
                stock,
                is_active
              )
              VALUES
              (?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING *`
            )
            .bind(
              name,
              category,
              description,
              price,
              salePrice,
              imageUrl,
              stock,
              isActive
            )
            .first();

        return json(
          {
            success: true,
            message:
              "Product created",
            product
          },
          201
        );

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCT UPDATE
    // =====================================================

    const adminProductMatch =
      url.pathname.match(
        /^\/api\/admin\/products\/(\d+)$/
      );

    if (
      adminProductMatch &&
      request.method === "PUT"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const productId =
          Number(
            adminProductMatch[1]
          );

        const existing =
          await env.DB
            .prepare(
              `SELECT *
               FROM products
               WHERE id = ?`
            )
            .bind(
              productId
            )
            .first();

        if (!existing) {
          return json(
            {
              success: false,
              error:
                "Product not found"
            },
            404
          );
        }

        const body =
          await request.json();

        const name =
          String(
            body.name ??
            existing.name
          ).trim();

        const category =
          String(
            body.category ??
            existing.category
          ).trim();

        const description =
          body.description ===
            undefined
            ? existing.description
            : nullableText(
                body.description
              );

        const price =
          body.price ===
            undefined
            ? Number(
                existing.price
              )
            : Number(
                body.price
              );

        let salePrice;

        if (
          body.sale_price ===
            undefined
        ) {
          salePrice =
            existing.sale_price;
        } else if (
          body.sale_price ===
            "" ||
          body.sale_price ===
            null
        ) {
          salePrice = null;
        } else {
          salePrice =
            Number(
              body.sale_price
            );
        }

        const imageUrl =
          body.image_url ===
            undefined
            ? existing.image_url
            : nullableText(
                body.image_url
              );

        const stock =
          body.stock ===
            undefined
            ? Number(
                existing.stock
              )
            : Number(
                body.stock
              );

        const isActive =
          body.is_active ===
            undefined
            ? Number(
                existing.is_active
              )
            : (
                body.is_active ===
                  false ||
                Number(
                  body.is_active
                ) === 0
                  ? 0
                  : 1
              );

        if (
          !name ||
          !category
        ) {
          return json(
            {
              success: false,
              error:
                "Name and category are required"
            },
            400
          );
        }

        if (
          !Number.isFinite(
            price
          ) ||
          price < 0
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid price"
            },
            400
          );
        }

        if (
          salePrice !== null &&
          (
            !Number.isFinite(
              Number(
                salePrice
              )
            ) ||
            Number(
              salePrice
            ) < 0
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid sale price"
            },
            400
          );
        }

        if (
          !Number.isInteger(
            stock
          ) ||
          stock < 0
        ) {
          return json(
            {
              success: false,
              error:
                "Stock must be 0 or more"
            },
            400
          );
        }

        const product =
          await env.DB
            .prepare(
              `UPDATE products
               SET
                 name = ?,
                 category = ?,
                 description = ?,
                 price = ?,
                 sale_price = ?,
                 image_url = ?,
                 stock = ?,
                 is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              name,
              category,
              description,
              price,
              salePrice,
              imageUrl,
              stock,
              isActive,
              productId
            )
            .first();

        return json({
          success: true,
          message:
            "Product updated",
          product
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCT STATUS
    // =====================================================

    const productStatusMatch =
      url.pathname.match(
        /^\/api\/admin\/products\/(\d+)\/status$/
      );

    if (
      productStatusMatch &&
      (
        request.method ===
          "PUT" ||
        request.method ===
          "PATCH"
      )
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const productId =
          Number(
            productStatusMatch[1]
          );

        const body =
          await request.json();

        const isActive =
          body.is_active ===
            true ||
          Number(
            body.is_active
          ) === 1
            ? 1
            : 0;

        const product =
          await env.DB
            .prepare(
              `UPDATE products
               SET is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              isActive,
              productId
            )
            .first();

        if (!product) {
          return json(
            {
              success: false,
              error:
                "Product not found"
            },
            404
          );
        }

        return json({
          success: true,
          message:
            isActive
              ? "Product activated"
              : "Product hidden",
          product
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN OFFERS - LIST
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/offers" &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const offers =
          await env.DB
            .prepare(
              `SELECT *
               FROM offers
               ORDER BY id DESC`
            )
            .all();

        return json({
          success: true,
          offers:
            offers.results
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN OFFER CREATE
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/offers" &&
      request.method === "POST"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const body =
          await request.json();

        const title =
          String(
            body.title || ""
          ).trim();

        if (!title) {
          return json(
            {
              success: false,
              error:
                "Offer title is required"
            },
            400
          );
        }

        const offer =
          await env.DB
            .prepare(
              `INSERT INTO offers
              (
                title,
                subtitle,
                image_url,
                button_text,
                button_url,
                start_at,
                end_at,
                is_active
              )
              VALUES
              (?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING *`
            )
            .bind(
              title,
              nullableText(
                body.subtitle
              ),
              nullableText(
                body.image_url
              ),
              nullableText(
                body.button_text
              ),
              nullableText(
                body.button_url
              ),
              nullableText(
                body.start_at
              ),
              nullableText(
                body.end_at
              ),
              Number(
                body.is_active
              ) === 0
                ? 0
                : 1
            )
            .first();

        return json(
          {
            success: true,
            message:
              "Offer created",
            offer
          },
          201
        );

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN OFFER UPDATE
    // =====================================================

    const offerMatch =
      url.pathname.match(
        /^\/api\/admin\/offers\/(\d+)$/
      );

    if (
      offerMatch &&
      request.method === "PUT"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const id =
          Number(
            offerMatch[1]
          );

        const existing =
          await env.DB
            .prepare(
              `SELECT *
               FROM offers
               WHERE id = ?`
            )
            .bind(id)
            .first();

        if (!existing) {
          return json(
            {
              success: false,
              error:
                "Offer not found"
            },
            404
          );
        }

        const body =
          await request.json();

        const title =
          String(
            body.title ??
            existing.title
          ).trim();

        if (!title) {
          return json(
            {
              success: false,
              error:
                "Offer title is required"
            },
            400
          );
        }

        const offer =
          await env.DB
            .prepare(
              `UPDATE offers
               SET
                 title = ?,
                 subtitle = ?,
                 image_url = ?,
                 button_text = ?,
                 button_url = ?,
                 start_at = ?,
                 end_at = ?,
                 is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              title,

              body.subtitle ===
                undefined
                ? existing.subtitle
                : nullableText(
                    body.subtitle
                  ),

              body.image_url ===
                undefined
                ? existing.image_url
                : nullableText(
                    body.image_url
                  ),

              body.button_text ===
                undefined
                ? existing.button_text
                : nullableText(
                    body.button_text
                  ),

              body.button_url ===
                undefined
                ? existing.button_url
                : nullableText(
                    body.button_url
                  ),

              body.start_at ===
                undefined
                ? existing.start_at
                : nullableText(
                    body.start_at
                  ),

              body.end_at ===
                undefined
                ? existing.end_at
                : nullableText(
                    body.end_at
                  ),

              body.is_active ===
                undefined
                ? Number(
                    existing.is_active
                  )
                : (
                    Number(
                      body.is_active
                    ) === 0
                      ? 0
                      : 1
                  ),

              id
            )
            .first();

        return json({
          success: true,
          message:
            "Offer updated",
          offer
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN OFFER STATUS
    // =====================================================

    const offerStatusMatch =
      url.pathname.match(
        /^\/api\/admin\/offers\/(\d+)\/status$/
      );

    if (
      offerStatusMatch &&
      (
        request.method ===
          "PUT" ||
        request.method ===
          "PATCH"
      )
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const id =
          Number(
            offerStatusMatch[1]
          );

        const body =
          await request.json();

        const isActive =
          Number(
            body.is_active
          ) === 1
            ? 1
            : 0;

        const offer =
          await env.DB
            .prepare(
              `UPDATE offers
               SET is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              isActive,
              id
            )
            .first();

        if (!offer) {
          return json(
            {
              success: false,
              error:
                "Offer not found"
            },
            404
          );
        }

        return json({
          success: true,
          offer
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN COUPONS - LIST
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/coupons" &&
      request.method === "GET"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const coupons =
          await env.DB
            .prepare(
              `SELECT *
               FROM coupons
               ORDER BY id DESC`
            )
            .all();

        return json({
          success: true,
          coupons:
            coupons.results
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN COUPON CREATE
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/coupons" &&
      request.method === "POST"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const body =
          await request.json();

        const code =
          normalizeCouponCode(
            body.code
          );

        const discountType =
          String(
            body.discount_type ||
            ""
          )
            .trim()
            .toLowerCase();

        const discountValue =
          Number(
            body.discount_value
          );

        if (!code) {
          return json(
            {
              success: false,
              error:
                "Coupon code is required"
            },
            400
          );
        }

        if (
          ![
            "percent",
            "percentage",
            "flat",
            "fixed"
          ].includes(
            discountType
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Discount type must be percent or flat"
            },
            400
          );
        }

        if (
          !Number.isFinite(
            discountValue
          ) ||
          discountValue <= 0
        ) {
          return json(
            {
              success: false,
              error:
                "Discount value must be greater than 0"
            },
            400
          );
        }

        if (
          (
            discountType ===
              "percent" ||
            discountType ===
              "percentage"
          ) &&
          discountValue > 100
        ) {
          return json(
            {
              success: false,
              error:
                "Percentage discount cannot exceed 100%"
            },
            400
          );
        }

        const coupon =
          await env.DB
            .prepare(
              `INSERT INTO coupons
              (
                code,
                discount_type,
                discount_value,
                min_order_amount,
                max_discount,
                usage_limit,
                used_count,
                start_at,
                end_at,
                is_active
              )
              VALUES
              (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
              RETURNING *`
            )
            .bind(
              code,
              discountType,
              discountValue,
              Number(
                body.min_order_amount ||
                0
              ),
              body.max_discount ===
                "" ||
              body.max_discount ===
                null ||
              body.max_discount ===
                undefined
                ? null
                : Number(
                    body.max_discount
                  ),
              body.usage_limit ===
                "" ||
              body.usage_limit ===
                null ||
              body.usage_limit ===
                undefined
                ? null
                : Number(
                    body.usage_limit
                  ),
              nullableText(
                body.start_at
              ),
              nullableText(
                body.end_at
              ),
              Number(
                body.is_active
              ) === 0
                ? 0
                : 1
            )
            .first();

        return json(
          {
            success: true,
            message:
              "Coupon created",
            coupon
          },
          201
        );

      } catch (error) {

        const message =
          String(
            error.message ||
            ""
          );

        if (
          message.includes(
            "UNIQUE"
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Coupon code already exists"
            },
            400
          );
        }

        return json(
          {
            success: false,
            error:
              message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN COUPON UPDATE
    // =====================================================

    const couponMatch =
      url.pathname.match(
        /^\/api\/admin\/coupons\/(\d+)$/
      );

    if (
      couponMatch &&
      request.method === "PUT"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const id =
          Number(
            couponMatch[1]
          );

        const existing =
          await env.DB
            .prepare(
              `SELECT *
               FROM coupons
               WHERE id = ?`
            )
            .bind(id)
            .first();

        if (!existing) {
          return json(
            {
              success: false,
              error:
                "Coupon not found"
            },
            404
          );
        }

        const body =
          await request.json();

        const code =
          normalizeCouponCode(
            body.code ??
            existing.code
          );

        const discountType =
          String(
            body.discount_type ??
            existing.discount_type
          )
            .trim()
            .toLowerCase();

        const discountValue =
          Number(
            body.discount_value ??
            existing.discount_value
          );

        if (
          !code ||
          ![
            "percent",
            "percentage",
            "flat",
            "fixed"
          ].includes(
            discountType
          ) ||
          !Number.isFinite(
            discountValue
          ) ||
          discountValue <= 0
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid coupon details"
            },
            400
          );
        }

        if (
          (
            discountType ===
              "percent" ||
            discountType ===
              "percentage"
          ) &&
          discountValue > 100
        ) {
          return json(
            {
              success: false,
              error:
                "Percentage discount cannot exceed 100%"
            },
            400
          );
        }

        const coupon =
          await env.DB
            .prepare(
              `UPDATE coupons
               SET
                 code = ?,
                 discount_type = ?,
                 discount_value = ?,
                 min_order_amount = ?,
                 max_discount = ?,
                 usage_limit = ?,
                 start_at = ?,
                 end_at = ?,
                 is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              code,
              discountType,
              discountValue,

              body.min_order_amount ===
                undefined
                ? Number(
                    existing.min_order_amount ||
                    0
                  )
                : Number(
                    body.min_order_amount ||
                    0
                  ),

              body.max_discount ===
                undefined
                ? existing.max_discount
                : (
                    body.max_discount ===
                      "" ||
                    body.max_discount ===
                      null
                      ? null
                      : Number(
                          body.max_discount
                        )
                  ),

              body.usage_limit ===
                undefined
                ? existing.usage_limit
                : (
                    body.usage_limit ===
                      "" ||
                    body.usage_limit ===
                      null
                      ? null
                      : Number(
                          body.usage_limit
                        )
                  ),

              body.start_at ===
                undefined
                ? existing.start_at
                : nullableText(
                    body.start_at
                  ),

              body.end_at ===
                undefined
                ? existing.end_at
                : nullableText(
                    body.end_at
                  ),

              body.is_active ===
                undefined
                ? Number(
                    existing.is_active
                  )
                : (
                    Number(
                      body.is_active
                    ) === 0
                      ? 0
                      : 1
                  ),

              id
            )
            .first();

        return json({
          success: true,
          message:
            "Coupon updated",
          coupon
        });

      } catch (error) {

        const message =
          String(
            error.message ||
            ""
          );

        if (
          message.includes(
            "UNIQUE"
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Coupon code already exists"
            },
            400
          );
        }

        return json(
          {
            success: false,
            error:
              message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN COUPON STATUS
    // =====================================================

    const couponStatusMatch =
      url.pathname.match(
        /^\/api\/admin\/coupons\/(\d+)\/status$/
      );

    if (
      couponStatusMatch &&
      (
        request.method ===
          "PUT" ||
        request.method ===
          "PATCH"
      )
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const id =
          Number(
            couponStatusMatch[1]
          );

        const body =
          await request.json();

        const isActive =
          Number(
            body.is_active
          ) === 1
            ? 1
            : 0;

        const coupon =
          await env.DB
            .prepare(
              `UPDATE coupons
               SET is_active = ?
               WHERE id = ?
               RETURNING *`
            )
            .bind(
              isActive,
              id
            )
            .first();

        if (!coupon) {
          return json(
            {
              success: false,
              error:
                "Coupon not found"
            },
            404
          );
        }

        return json({
          success: true,
          coupon
        });

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCT IMAGE UPLOAD
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/upload-image" &&
      request.method === "POST"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        if (
          !env.GITHUB_TOKEN
        ) {
          return json(
            {
              success: false,
              error:
                "GITHUB_TOKEN is not configured"
            },
            503
          );
        }

        const formData =
          await request
            .formData();

        const file =
          formData.get(
            "file"
          );

        if (
          !file ||
          typeof file.arrayBuffer !==
            "function"
        ) {
          return json(
            {
              success: false,
              error:
                "Image file is required"
            },
            400
          );
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (
          !allowedTypes.includes(
            file.type
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Only JPG, PNG or WEBP images are allowed"
            },
            400
          );
        }

        if (
          file.size >
          5 * 1024 * 1024
        ) {
          return json(
            {
              success: false,
              error:
                "Image must be smaller than 5 MB"
            },
            400
          );
        }

        const extension =
          file.type ===
            "image/png"
            ? "png"
            : file.type ===
                "image/webp"
              ? "webp"
              : "jpg";

        const safeName =
          `product-${Date.now()}-${Math.floor(
            Math.random() *
            100000
          )}.${extension}`;

        const repoOwner =
          "srilathacreations";

        const repoName =
          "srilathacreations";

        const repoPath =
          `assets/images/products/${safeName}`;

        const buffer =
          await file
            .arrayBuffer();

        let binary = "";

        const bytes =
          new Uint8Array(
            buffer
          );

        const chunkSize =
          0x8000;

        for (
          let i = 0;
          i < bytes.length;
          i += chunkSize
        ) {
          binary +=
            String.fromCharCode(
              ...bytes.subarray(
                i,
                i + chunkSize
              )
            );
        }

        const base64 =
          btoa(binary);

        const githubResponse =
          await fetch(
            `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${repoPath}`,
            {
              method:
                "PUT",

              headers: {
                Authorization:
                  `Bearer ${env.GITHUB_TOKEN}`,

                Accept:
                  "application/vnd.github+json",

                "X-GitHub-Api-Version":
                  "2022-11-28",

                "User-Agent":
                  "Srilatha-Creations-Worker",

                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  message:
                    `Upload product image ${safeName}`,
                  content:
                    base64,
                  branch:
                    "main"
                })
            }
          );

        const githubData =
          await githubResponse
            .json();

        if (
          !githubResponse.ok
        ) {
          return json(
            {
              success: false,
              error:
                githubData.message ||
                "Unable to upload image to GitHub"
            },
            githubResponse.status
          );
        }

        return json(
          {
            success: true,

            message:
              "Image uploaded successfully",

            filename:
              safeName,

            image_url:
              `/assets/images/products/${safeName}`,

            github_path:
              repoPath
          },
          201
        );

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to upload image"
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN OFFER BANNER IMAGE UPLOAD
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/upload-offer-image" &&
      request.method === "POST"
    ) {
      const denied =
        requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        if (
          !env.GITHUB_TOKEN
        ) {
          return json(
            {
              success: false,
              error:
                "GITHUB_TOKEN is not configured"
            },
            503
          );
        }

        const formData =
          await request
            .formData();

        const file =
          formData.get(
            "file"
          );

        if (
          !file ||
          typeof file.arrayBuffer !==
            "function"
        ) {
          return json(
            {
              success: false,
              error:
                "Offer banner image is required"
            },
            400
          );
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (
          !allowedTypes.includes(
            file.type
          )
        ) {
          return json(
            {
              success: false,
              error:
                "Only JPG, PNG or WEBP images are allowed"
            },
            400
          );
        }

        if (
          file.size >
          5 * 1024 * 1024
        ) {
          return json(
            {
              success: false,
              error:
                "Offer banner must be smaller than 5 MB"
            },
            400
          );
        }

        const extension =
          file.type ===
            "image/png"
            ? "png"
            : file.type ===
                "image/webp"
              ? "webp"
              : "jpg";

        const safeName =
          `offer-${Date.now()}-${Math.floor(
            Math.random() *
            100000
          )}.${extension}`;

        const repoOwner =
          "srilathacreations";

        const repoName =
          "srilathacreations";

        const repoPath =
          `assets/images/offers/${safeName}`;

        const buffer =
          await file
            .arrayBuffer();

        let binary = "";

        const bytes =
          new Uint8Array(
            buffer
          );

        const chunkSize =
          0x8000;

        for (
          let i = 0;
          i < bytes.length;
          i += chunkSize
        ) {
          binary +=
            String.fromCharCode(
              ...bytes.subarray(
                i,
                i + chunkSize
              )
            );
        }

        const base64 =
          btoa(binary);

        const githubResponse =
          await fetch(
            `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${repoPath}`,
            {
              method:
                "PUT",

              headers: {
                Authorization:
                  `Bearer ${env.GITHUB_TOKEN}`,

                Accept:
                  "application/vnd.github+json",

                "X-GitHub-Api-Version":
                  "2022-11-28",

                "User-Agent":
                  "Srilatha-Creations-Worker",

                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  message:
                    `Upload offer banner ${safeName}`,
                  content:
                    base64,
                  branch:
                    "main"
                })
            }
          );

        const githubData =
          await githubResponse
            .json();

        if (
          !githubResponse.ok
        ) {
          return json(
            {
              success: false,
              error:
                githubData.message ||
                "Unable to upload offer banner"
            },
            githubResponse.status
          );
        }

        return json(
          {
            success: true,

            message:
              "Offer banner uploaded successfully",

            filename:
              safeName,

            image_url:
              `/assets/images/offers/${safeName}`,

            github_path:
              repoPath
          },
          201
        );

      } catch (error) {
        return json(
          {
            success: false,
            error:
              error.message ||
              "Unable to upload offer banner"
          },
          500
        );
      }
    }

    // =====================================================
    // STATIC WEBSITE / ADMIN / ASSETS
    // =====================================================

    return env.ASSETS.fetch(
      request
    );
  }
};
