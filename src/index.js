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

    // =====================================================
    // API TEST
    // =====================================================

    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const result = await env.DB
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all();

        return json({
          success: true,
          message: "Srilatha Creations backend is working",
          database: "Connected",
          tables: result.results
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

    if (url.pathname === "/api/products" && request.method === "GET") {
      try {
        const products = await env.DB
          .prepare(
            `SELECT *
             FROM products
             WHERE is_active = 1
             ORDER BY id DESC`
          )
          .all();

        return json(products.results);
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
    // CREATE ORDER - COD
    // Supports current frontend:
    // {
    //   customer:{name,phone,email,address,city,state,pincode},
    //   items:[{id,qty}]
    // }
    // =====================================================

    if (url.pathname === "/api/orders" && request.method === "POST") {
      try {
        const body = await request.json();

        const customer = body.customer || {};

        const customerName = String(
          customer.name ||
          body.customer_name ||
          ""
        ).trim();

        const phone = cleanPhone(
          customer.phone ||
          body.phone ||
          ""
        );

        const email = String(
          customer.email ||
          body.email ||
          ""
        ).trim();

        const address = String(
          customer.address ||
          body.address ||
          ""
        ).trim();

        const city = String(
          customer.city ||
          body.city ||
          ""
        ).trim();

        const state = String(
          customer.state ||
          body.state ||
          ""
        ).trim();

        const pincode = String(
          customer.pincode ||
          body.pincode ||
          ""
        )
          .replace(/\D/g, "");

        const items =
          Array.isArray(body.items)
            ? body.items
            : [];

        // -------------------------
        // VALIDATION
        // -------------------------

        if (!customerName) {
          return json(
            {
              success: false,
              error: "Customer name is required"
            },
            400
          );
        }

        if (!/^[0-9]{10}$/.test(phone)) {
          return json(
            {
              success: false,
              error: "Enter a valid 10 digit mobile number"
            },
            400
          );
        }

        if (!address) {
          return json(
            {
              success: false,
              error: "Delivery address is required"
            },
            400
          );
        }

        if (pincode && !/^[0-9]{6}$/.test(pincode)) {
          return json(
            {
              success: false,
              error: "Enter a valid 6 digit PIN code"
            },
            400
          );
        }

        if (!items.length) {
          return json(
            {
              success: false,
              error: "Cart is empty"
            },
            400
          );
        }

        // -------------------------
        // VERIFY PRODUCTS
        // -------------------------

        const verifiedItems = [];
        let subtotal = 0;

        for (const item of items) {
          const productId = Number(
            item.id ||
            item.product_id
          );

          const quantity = Number(
            item.qty ||
            item.quantity ||
            0
          );

          if (
            !Number.isInteger(productId) ||
            productId <= 0 ||
            !Number.isInteger(quantity) ||
            quantity <= 0
          ) {
            return json(
              {
                success: false,
                error: "Invalid cart item"
              },
              400
            );
          }

          const product = await env.DB
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
            .bind(productId)
            .first();

          if (
            !product ||
            Number(product.is_active) !== 1
          ) {
            return json(
              {
                success: false,
                error: "One of the selected products is unavailable"
              },
              400
            );
          }

          if (Number(product.stock) < quantity) {
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
            Number(product.price || 0);

          const salePrice =
            product.sale_price !== null &&
            product.sale_price !== undefined &&
            Number(product.sale_price) > 0
              ? Number(product.sale_price)
              : null;

          const finalPrice =
            salePrice !== null
              ? salePrice
              : regularPrice;

          const itemTotal =
            finalPrice * quantity;

          subtotal += itemTotal;

          verifiedItems.push({
            product_id: Number(product.id),
            product_name: product.name,
            quantity,
            price: finalPrice,
            total: itemTotal
          });
        }

        // -------------------------
        // TOTALS
        // -------------------------

        const deliveryCharge = 0;
        const totalAmount =
          subtotal + deliveryCharge;

        // -------------------------
        // CUSTOMER
        // -------------------------

        let existingCustomer = await env.DB
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

        if (existingCustomer) {
          customerId =
            Number(existingCustomer.id);

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
                VALUES (?, ?, ?, ?, ?, ?, ?)
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
            Number(createdCustomer.id);
        }

        // -------------------------
        // ORDER NUMBER
        // -------------------------

        const now = new Date();

        const datePart =
          now.getUTCFullYear().toString() +
          String(
            now.getUTCMonth() + 1
          ).padStart(2, "0") +
          String(
            now.getUTCDate()
          ).padStart(2, "0");

        const randomPart =
          Math.floor(
            100000 +
            Math.random() * 900000
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
                ?, ?, ?, ?, ?, ?, ?
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
              deliveryCharge,
              totalAmount,
              "COD",
              "pending",
              null,
              "pending"
            )
            .first();

        const orderId =
          Number(createdOrder.id);

        // -------------------------
        // ORDER ITEMS + STOCK
        // -------------------------

        for (const item of verifiedItems) {
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
                 SET stock = stock - ?
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
              stockUpdate.meta?.changes || 0
            ) !== 1
          ) {
            throw new Error(
              `Unable to update stock for ${item.product_name}`
            );
          }
        }

        return json(
          {
            success: true,
            message: "Order placed successfully",

            order: {
              id: orderId,
              order_number: orderNumber,
              customer_name: customerName,
              phone,
              subtotal,
              delivery_charge:
                deliveryCharge,
              total_amount:
                totalAmount,
              payment_method: "COD",
              payment_status:
                "pending",
              order_status:
                "pending"
            },

            order_id: orderId,
            order_number: orderNumber,
            total: totalAmount
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
    // PUBLIC ORDER LOOKUP
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
          );

        const order =
          await env.DB
            .prepare(
              `SELECT
                order_number,
                customer_name,
                total_amount,
                payment_method,
                payment_status,
                order_status,
                created_at
               FROM orders
               WHERE order_number = ?`
            )
            .bind(orderNumber)
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error: "Order not found"
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
            error: error.message
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
      const denied = requireAdmin();

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
      const denied = requireAdmin();

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
                delivery_charge,
                total_amount,
                payment_method,
                payment_status,
                payment_id,
                order_status,
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
            error: error.message
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
      const denied = requireAdmin();

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
            .bind(orderId)
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error: "Order not found"
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
            .bind(orderId)
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
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN UPDATE ORDER STATUS
    // Supports PUT used by current admin.html
    // =====================================================

    const statusMatch =
      url.pathname.match(
        /^\/api\/admin\/orders\/(\d+)\/status$/
      );

    if (
      statusMatch &&
      (
        request.method === "PUT" ||
        request.method === "PATCH"
      )
    ) {
      const denied = requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        const orderId =
          Number(statusMatch[1]);

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
            .bind(orderId)
            .first();

        if (!order) {
          return json(
            {
              success: false,
              error: "Order not found"
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
          oldStatus === "cancelled" &&
          newStatus !== "cancelled"
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

        // Restore stock when cancelled
        if (
          oldStatus !== "cancelled" &&
          newStatus === "cancelled"
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
              .bind(orderId)
              .all();

          for (
            const item of items.results
          ) {
            if (item.product_id) {
              await env.DB
                .prepare(
                  `UPDATE products
                   SET stock =
                     stock + ?
                   WHERE id = ?`
                )
                .bind(
                  Number(
                    item.quantity || 0
                  ),
                  Number(
                    item.product_id
                  )
                )
                .run();
            }
          }
        }

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

        return json({
          success: true,
          message:
            "Order status updated",
          order_id: orderId,
          order_status:
            newStatus
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
    // ADMIN PRODUCTS - LIST ALL
    // Includes inactive products
    // =====================================================

    if (
      url.pathname ===
        "/api/admin/products" &&
      request.method === "GET"
    ) {
      const denied = requireAdmin();

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
            error: error.message
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
      const denied = requireAdmin();

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
          Number(body.price);

        const salePrice =
          body.sale_price === "" ||
          body.sale_price === null ||
          body.sale_price === undefined
            ? null
            : Number(
                body.sale_price
              );

        const imageUrl =
          nullableText(
            body.image_url
          );

        const stock =
          Number(body.stock ?? 0);

        const isActive =
          body.is_active === false ||
          Number(body.is_active) === 0
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
          !Number.isFinite(price) ||
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
          !Number.isInteger(stock) ||
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
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCT - UPDATE
    // =====================================================

    const adminProductMatch =
      url.pathname.match(
        /^\/api\/admin\/products\/(\d+)$/
      );

    if (
      adminProductMatch &&
      request.method === "PUT"
    ) {
      const denied = requireAdmin();

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
            .bind(productId)
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
          body.description === undefined
            ? existing.description
            : nullableText(
                body.description
              );

        const price =
          body.price === undefined
            ? Number(
                existing.price
              )
            : Number(body.price);

        let salePrice;

        if (
          body.sale_price === undefined
        ) {
          salePrice =
            existing.sale_price;
        } else if (
          body.sale_price === "" ||
          body.sale_price === null
        ) {
          salePrice = null;
        } else {
          salePrice =
            Number(
              body.sale_price
            );
        }

        const imageUrl =
          body.image_url === undefined
            ? existing.image_url
            : nullableText(
                body.image_url
              );

        const stock =
          body.stock === undefined
            ? Number(
                existing.stock
              )
            : Number(body.stock);

        const isActive =
          body.is_active === undefined
            ? Number(
                existing.is_active
              )
            : (
                body.is_active === false ||
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
          !Number.isFinite(price) ||
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
              Number(salePrice)
            ) ||
            Number(salePrice) < 0
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
          !Number.isInteger(stock) ||
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
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // ADMIN PRODUCT - ACTIVE / INACTIVE
    // =====================================================

    const productStatusMatch =
      url.pathname.match(
        /^\/api\/admin\/products\/(\d+)\/status$/
      );

    if (
      productStatusMatch &&
      (
        request.method === "PUT" ||
        request.method === "PATCH"
      )
    ) {
      const denied = requireAdmin();

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
          body.is_active === true ||
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
            error: error.message
          },
          500
        );
      }
    }

    // =====================================================
    // STATIC WEBSITE / ADMIN PAGE / ASSETS
    // =====================================================

   
    
    
        // =====================================================
    // ADMIN PRODUCT IMAGE UPLOAD TO GITHUB
    // =====================================================

    if (
      url.pathname === "/api/admin/upload-image" &&
      request.method === "POST"
    ) {
      const denied = requireAdmin();

      if (denied) {
        return denied;
      }

      try {
        if (!env.GITHUB_TOKEN) {
          return json(
            {
              success: false,
              error: "GITHUB_TOKEN is not configured"
            },
            503
          );
        }

        const formData = await request.formData();
        const file = formData.get("file");

        if (!file || typeof file.arrayBuffer !== "function") {
          return json(
            {
              success: false,
              error: "Image file is required"
            },
            400
          );
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        if (!allowedTypes.includes(file.type)) {
          return json(
            {
              success: false,
              error: "Only JPG, PNG or WEBP images are allowed"
            },
            400
          );
        }

        const maxSize = 5 * 1024 * 1024;

        if (file.size > maxSize) {
          return json(
            {
              success: false,
              error: "Image must be smaller than 5 MB"
            },
            400
          );
        }

        const extension =
          file.type === "image/png"
            ? "png"
            : file.type === "image/webp"
              ? "webp"
              : "jpg";

        const safeName =
          `product-${Date.now()}-${Math.floor(
            Math.random() * 100000
          )}.${extension}`;

        const repoOwner = "srilathacreations";
        const repoName = "srilathacreations";

        const repoPath =
          `assets/images/products/${safeName}`;

        const buffer = await file.arrayBuffer();

        let binary = "";
        const bytes = new Uint8Array(buffer);

        const chunkSize = 0x8000;

        for (
          let i = 0;
          i < bytes.length;
          i += chunkSize
        ) {
          binary += String.fromCharCode(
            ...bytes.subarray(
              i,
              i + chunkSize
            )
          );
        }

        const base64 = btoa(binary);

        const githubResponse = await fetch(
          `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${repoPath}`,
          {
            method: "PUT",

            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Srilatha-Creations-Worker",
              "Content-Type": "application/json"
            },

            body: JSON.stringify({
              message: `Upload product image ${safeName}`,
              content: base64,
              branch: "main"
            })
          }
        );

        const githubData =
          await githubResponse.json();

        if (!githubResponse.ok) {
          console.error(
            "GitHub upload error:",
            githubData
          );

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
            message: "Image uploaded successfully",

            filename: safeName,

            image_url:
              `/assets/images/products/${safeName}`,

            github_path: repoPath
          },
          201
        );
      } catch (error) {
        console.error(
          "Image upload error:",
          error
        );

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
    
    return env.ASSETS.fetch(request);
  }
};
